#include "audio.h"

#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <libavformat/avformat.h>

#include "audio_output.h"
#include "audio_reader.h"
#include "mix.h"
#include "tempo.h"

#define RATE MIX_RATE
/* the mix goes out in blocks this long, so a seek or a new mix is picked up quickly */
#define BLOCK_FRAMES 1024
/* a playing track with a full queue looks again this often; the device drains it in real time */
#define FULL_WAIT_SECONDS 0.005

/* one sound of the mix: its file and stream, and the reader once the worker has opened it */
typedef struct Voice {
    char *path;
    int stream;
    AudioReader *reader;
    /* opening it failed; it stays silent rather than stopping the whole mix */
    int unreadable;
} Voice;

struct AudioTrack {
    double duration;
    AudioOutput *output;
    pthread_t thread;
    int thread_started;
    atomic_int closing;

    pthread_mutex_t lock;
    pthread_cond_t changed;
    /* under lock: what the clock asked for */
    uint64_t wanted_generation;
    double wanted_seconds;
    double wanted_rate;
    int wanted_running;
    /* the speed of the generation being played, for turning heard sound into media time */
    uint64_t rate_generation;
    double generation_rate;
    int failed;
    char error[160];
    /* under lock: a mix the worker hasn't taken up yet */
    double next_duration;
    MixPiece *next_pieces;
    size_t next_piece_count;
    Voice *next_voices;
    size_t next_voice_count;
    int mix_waiting;

    /* the worker's own */
    uint64_t generation;
    /* NULL at normal speed */
    Tempo *tempo;
    int running;
    /* where on the timeline the next queued sample plays */
    double cursor;
    int finished;
    MixPiece *pieces;
    size_t piece_count;
    Voice *voices;
    size_t voice_count, unreadable_count;
    float block[BLOCK_FRAMES * 2];
    float scratch[BLOCK_FRAMES * 2];
    char read_error[160];
};

static void fail(AudioTrack *t, const char *message) {
    pthread_mutex_lock(&t->lock);
    if (!t->failed) snprintf(t->error, sizeof(t->error), "%s", message);
    t->failed = 1;
    pthread_mutex_unlock(&t->lock);
}

static int interrupted(void *opaque) {
    return atomic_load(&((AudioTrack *)opaque)->closing);
}

static int superseded(AudioTrack *t) {
    if (atomic_load(&t->closing)) return 1;
    pthread_mutex_lock(&t->lock);
    int newer = t->wanted_generation != t->generation;
    pthread_mutex_unlock(&t->lock);
    return newer;
}

/* sound is heard only while the clock runs this generation */
static void follow_running(AudioTrack *t) {
    pthread_mutex_lock(&t->lock);
    int running = t->wanted_running && t->wanted_generation == t->generation;
    pthread_mutex_unlock(&t->lock);
    if (running == t->running) return;
    audio_output_pause(t->output, !running);
    t->running = running;
}

static void wait_for_change(AudioTrack *t, double seconds) {
    pthread_mutex_lock(&t->lock);
    if (!atomic_load(&t->closing)) {
        if (seconds > 0) {
            struct timespec until;
            clock_gettime(CLOCK_REALTIME, &until);
            long nanoseconds = until.tv_nsec + (long)(seconds * 1e9);
            until.tv_sec += nanoseconds / 1000000000L;
            until.tv_nsec = nanoseconds % 1000000000L;
            pthread_cond_timedwait(&t->changed, &t->lock, &until);
        } else {
            pthread_cond_wait(&t->changed, &t->lock);
        }
    }
    pthread_mutex_unlock(&t->lock);
}

/* hands all of `frames` to the device, waiting for room; 0 when a newer generation or closing
   cut it short */
static int write_out(AudioTrack *t, const float *samples, size_t frames) {
    while (frames) {
        if (superseded(t)) return 0;
        follow_running(t);
        size_t written = audio_output_write(t->output, samples, frames, t->generation);
        samples += written * 2;
        frames -= written;
        if (!written && audio_output_failed(t->output)) return 0;
        /* a paused track only wakes for the clock; a playing one for the device to make room */
        if (frames) wait_for_change(t, t->running ? FULL_WAIT_SECONDS : 0);
    }
    return 1;
}

/* everything the tempo filter has ready goes out */
static int drain_tempo(AudioTrack *t) {
    size_t frames;
    const float *samples;
    while ((samples = tempo_take(t->tempo, &frames)))
        if (!write_out(t, samples, frames)) return 0;
    return 1;
}

/* queues `frames` of the timeline, at the generation's speed; 0 when cut short */
static int put(AudioTrack *t, const float *samples, size_t frames) {
    /* the cursor is in timeline time, whatever the speed the sound goes out at */
    t->cursor += (double)frames / RATE;
    if (!t->tempo) return write_out(t, samples, frames);
    if (!tempo_feed(t->tempo, samples, frames)) {
        fail(t, "The sound could not change speed.");
        return 0;
    }
    return drain_tempo(t);
}

static void finish(AudioTrack *t) {
    t->finished = 1;
    /* what the tempo filter still holds is the end of the sound */
    if (t->tempo && (!tempo_feed(t->tempo, NULL, 0) || !drain_tempo(t))) return;
    audio_output_finish(t->output, t->generation);
}

/* takes up a new generation; 0 while there is none to play */
static int follow_generation(AudioTrack *t) {
    pthread_mutex_lock(&t->lock);
    uint64_t generation = t->wanted_generation;
    double seconds = t->wanted_seconds;
    double rate = t->wanted_rate;
    pthread_mutex_unlock(&t->lock);
    if (!generation) return 0;
    if (generation != t->generation) {
        audio_output_reset(t->output, generation);
        t->running = 0;
        t->generation = generation;
        /* a new generation starts with an empty filter at its own speed */
        tempo_close(t->tempo);
        t->tempo = NULL;
        if (rate != 1) {
            t->tempo = tempo_open(rate);
            if (!t->tempo) {
                fail(t, "The sound could not change speed.");
                return 0;
            }
        }
        pthread_mutex_lock(&t->lock);
        t->rate_generation = generation;
        t->generation_rate = rate;
        pthread_mutex_unlock(&t->lock);
        t->cursor = seconds;
        t->finished = 0;
        if (seconds >= t->duration) finish(t);
    }
    follow_running(t);
    return 1;
}

static int read_voice(void *opaque, int index, double seconds, float *samples, size_t frames) {
    AudioTrack *t = opaque;
    if (index < 0 || (size_t)index >= t->voice_count) return 1;
    Voice *voice = &t->voices[index];
    if (!voice->reader && !voice->unreadable) {
        char error[160];
        voice->reader = audio_reader_open(voice->path, voice->stream, interrupted, t, error, sizeof(error));
        if (!voice->reader) {
            voice->unreadable = 1;
            /* one sound that can't be read stays silent; the mix only fails when none can */
            if (++t->unreadable_count == t->voice_count) {
                snprintf(t->read_error, sizeof(t->read_error), "%s", error);
                return 0;
            }
        }
    }
    if (!voice->reader) return 1;
    return audio_reader_read(voice->reader, seconds, samples, frames, t->read_error, sizeof(t->read_error));
}

static void free_voices(Voice *voices, size_t count) {
    for (size_t i = 0; i < count; i++) {
        audio_reader_close(voices[i].reader);
        free(voices[i].path);
    }
    free(voices);
}

/* a new mix replaces the old one between blocks; a sound in both keeps its open reader */
static void take_mix(AudioTrack *t) {
    pthread_mutex_lock(&t->lock);
    if (t->next_duration > 0) {
        t->duration = t->next_duration;
        t->next_duration = 0;
    }
    if (!t->mix_waiting) {
        pthread_mutex_unlock(&t->lock);
        return;
    }
    MixPiece *pieces = t->next_pieces;
    size_t piece_count = t->next_piece_count;
    Voice *voices = t->next_voices;
    size_t voice_count = t->next_voice_count;
    t->next_pieces = NULL;
    t->next_voices = NULL;
    t->mix_waiting = 0;
    pthread_mutex_unlock(&t->lock);
    for (size_t i = 0; i < voice_count; i++)
        for (size_t j = 0; j < t->voice_count; j++) {
            Voice *old = &t->voices[j];
            if (old->reader && old->stream == voices[i].stream && !strcmp(old->path, voices[i].path)) {
                voices[i].reader = old->reader;
                old->reader = NULL;
                break;
            }
        }
    free_voices(t->voices, t->voice_count);
    free(t->pieces);
    t->voices = voices;
    t->voice_count = voice_count;
    t->unreadable_count = 0;
    t->pieces = pieces;
    t->piece_count = piece_count;
}

/* one block of the mix from the cursor; 0 when there is nothing to do until the clock asks */
static int mix_step(AudioTrack *t) {
    take_mix(t);
    double left = (t->duration - t->cursor) * RATE;
    size_t frames = left >= BLOCK_FRAMES ? BLOCK_FRAMES : (size_t)fmax(0, ceil(left - 1e-6));
    if (!frames) {
        finish(t);
        return 1;
    }
    Mix mix = {t->pieces, t->piece_count};
    if (!mix_render(&mix, t->cursor, frames, read_voice, t, t->block, t->scratch)) {
        if (!atomic_load(&t->closing)) fail(t, t->read_error);
        return 0;
    }
    if (!put(t, t->block, frames)) return superseded(t);
    if (t->cursor >= t->duration - 1.0 / RATE) finish(t);
    return 1;
}

static void *worker(void *opaque) {
    AudioTrack *t = opaque;
    while (!atomic_load(&t->closing)) {
        pthread_mutex_lock(&t->lock);
        int failed = t->failed;
        pthread_mutex_unlock(&t->lock);
        if (failed || !follow_generation(t) || t->finished) {
            wait_for_change(t, 0);
            continue;
        }
        if (!mix_step(t) && !superseded(t)) wait_for_change(t, 0);
    }
    return NULL;
}

void audio_track_set_duration(AudioTrack *t, double duration_seconds) {
    pthread_mutex_lock(&t->lock);
    t->next_duration = duration_seconds;
    pthread_cond_broadcast(&t->changed);
    pthread_mutex_unlock(&t->lock);
}

int audio_track_set_mix(AudioTrack *t, const char *const *paths, const int *streams, size_t voice_count,
                        const MixPiece *pieces, size_t piece_count) {
    Voice *voices = voice_count ? calloc(voice_count, sizeof(*voices)) : NULL;
    MixPiece *copied = piece_count ? malloc(piece_count * sizeof(*copied)) : NULL;
    if ((voice_count && !voices) || (piece_count && !copied)) {
        free(voices);
        free(copied);
        return 0;
    }
    for (size_t i = 0; i < voice_count; i++) {
        voices[i].stream = streams[i];
        if (!(voices[i].path = strdup(paths[i]))) {
            free_voices(voices, i);
            free(copied);
            return 0;
        }
    }
    if (piece_count) memcpy(copied, pieces, piece_count * sizeof(*copied));
    pthread_mutex_lock(&t->lock);
    free_voices(t->next_voices, t->next_voice_count);
    free(t->next_pieces);
    t->next_voices = voices;
    t->next_voice_count = voice_count;
    t->next_pieces = copied;
    t->next_piece_count = piece_count;
    t->mix_waiting = 1;
    pthread_cond_broadcast(&t->changed);
    pthread_mutex_unlock(&t->lock);
    return 1;
}

/* how many sound streams the file has; 0 when it has none or can't be read */
static int sound_streams(const char *path) {
    AVFormatContext *format = NULL;
    if (avformat_open_input(&format, path, NULL, NULL) < 0) return 0;
    int count = 0;
    if (avformat_find_stream_info(format, NULL) >= 0)
        for (unsigned i = 0; i < format->nb_streams; i++)
            count += format->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO;
    avformat_close_input(&format);
    return count;
}

AudioTrack *audio_track_open(const char *path, double duration_seconds, char *error, size_t error_size) {
    error[0] = 0;
    /* no sound at all is not an error: the video plays on the system clock */
    if (!sound_streams(path)) return NULL;
    AudioTrack *t = audio_track_new(duration_seconds, error, error_size);
    if (!t) return NULL;
    /* until the page sends a mix, the video's first sound stream plays whole, at full level */
    const int stream = 0;
    MixPiece whole = {.voice = 0, .start = 0, .end = duration_seconds, .source_in = 0, .gain = 1};
    if (!audio_track_set_mix(t, &path, &stream, 1, &whole, 1)) {
        snprintf(error, error_size, "Out of memory while opening the sound.");
        audio_track_close(t);
        return NULL;
    }
    return t;
}

AudioTrack *audio_track_new(double duration_seconds, char *error, size_t error_size) {
    error[0] = 0;
    AudioTrack *t = calloc(1, sizeof(*t));
    if (!t) {
        snprintf(error, error_size, "Out of memory while opening the sound.");
        return NULL;
    }
    pthread_mutex_init(&t->lock, NULL);
    pthread_cond_init(&t->changed, NULL);
    t->duration = duration_seconds;
    t->output = audio_output_open(error, error_size);
    if (!t->output) goto failed;
    if (pthread_create(&t->thread, NULL, worker, t) != 0) {
        snprintf(error, error_size, "The sound could not start its thread.");
        goto failed;
    }
    t->thread_started = 1;
    return t;
failed:
    audio_track_close(t);
    return NULL;
}

void audio_track_close(AudioTrack *t) {
    if (!t) return;
    atomic_store(&t->closing, 1);
    pthread_mutex_lock(&t->lock);
    pthread_cond_broadcast(&t->changed);
    pthread_mutex_unlock(&t->lock);
    if (t->thread_started) pthread_join(t->thread, NULL);
    audio_output_close(t->output);
    tempo_close(t->tempo);
    free_voices(t->voices, t->voice_count);
    free(t->pieces);
    free_voices(t->next_voices, t->next_voice_count);
    free(t->next_pieces);
    pthread_cond_destroy(&t->changed);
    pthread_mutex_destroy(&t->lock);
    free(t);
}

void audio_track_want(AudioTrack *t, uint64_t generation, double seconds, double rate, int running) {
    pthread_mutex_lock(&t->lock);
    if (generation != t->wanted_generation) {
        t->wanted_generation = generation;
        t->wanted_seconds = seconds;
        t->wanted_rate = rate;
    }
    t->wanted_running = running != 0;
    pthread_cond_broadcast(&t->changed);
    pthread_mutex_unlock(&t->lock);
}

void audio_track_volume(AudioTrack *t, float gain) {
    audio_output_volume(t->output, gain);
}

void audio_track_status(AudioTrack *t, AudioTrackStatus *status) {
    AudioOutputStatus output;
    audio_output_status(t->output, &output);
    status->generation = output.generation;
    status->underruns = output.underruns;
    pthread_mutex_lock(&t->lock);
    /* the device plays sound seconds; at another speed each one holds that many timeline seconds */
    double rate = output.generation == t->rate_generation ? t->generation_rate : 1;
    status->played = output.played * rate;
    status->failed = t->failed || output.failed;
    snprintf(status->error, sizeof(status->error), "%s", t->failed ? t->error : output.error);
    pthread_mutex_unlock(&t->lock);
}
