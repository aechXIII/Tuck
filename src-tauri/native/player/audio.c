#include "audio.h"

#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>

#include "audio_output.h"

#define RATE 48000
/* silence goes out in pieces this long, so a seek during a long gap is picked up quickly */
#define SILENCE_FRAMES 1024
/* a playing track with a full queue looks again this often; the device drains it in real time */
#define FULL_WAIT_SECONDS 0.005
/* broken packets in a row before the sound counts as undecodable */
#define BAD_PACKET_LIMIT 64

struct AudioTrack {
    AVFormatContext *format;
    AVCodecContext *codec;
    int stream;
    AVRational time_base;
    /* the file's start time, which the picture's decoder takes off its frame times too */
    double start;
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
    int wanted_running;
    int failed;
    char error[160];

    /* the worker's own */
    uint64_t generation;
    int running;
    /* where on the timeline the next queued sample plays */
    double cursor;
    int ended, finished;
    int bad_packets;
    SwrContext *resampler;
    AVChannelLayout resampler_layout;
    int resampler_rate, resampler_format;
    float *samples;
    int sample_capacity;
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

/* queues all of `frames`, waiting for room; 0 when a newer generation or closing cut it short */
static int put(AudioTrack *t, const float *samples, size_t frames) {
    while (frames) {
        if (superseded(t)) return 0;
        follow_running(t);
        size_t written = audio_output_write(t->output, samples, frames, t->generation);
        samples += written * 2;
        frames -= written;
        t->cursor += (double)written / RATE;
        if (!written && audio_output_failed(t->output)) return 0;
        /* a paused track only wakes for the clock; a playing one for the device to make room */
        if (frames) wait_for_change(t, t->running ? FULL_WAIT_SECONDS : 0);
    }
    return 1;
}

/* silence up to `until` on the timeline, where the file has no sound */
static int pad_to(AudioTrack *t, double until) {
    static const float silence[SILENCE_FRAMES * 2];
    long gap = lround((until - t->cursor) * RATE);
    while (gap > 0) {
        size_t frames = gap > SILENCE_FRAMES ? SILENCE_FRAMES : (size_t)gap;
        if (!put(t, silence, frames)) return 0;
        gap -= (long)frames;
    }
    return 1;
}

static void finish(AudioTrack *t) {
    t->finished = 1;
    audio_output_finish(t->output, t->generation);
}

static int restart(AudioTrack *t, double seconds) {
    t->cursor = seconds;
    t->ended = 0;
    t->finished = 0;
    t->bad_packets = 0;
    /* the resampler holds samples from the old position */
    swr_free(&t->resampler);
    int64_t timestamp = llround((seconds + t->start) / av_q2d(t->time_base));
    if (av_seek_frame(t->format, t->stream, timestamp, AVSEEK_FLAG_BACKWARD) < 0) {
        int64_t position = llround((seconds + t->start) * AV_TIME_BASE);
        if (avformat_seek_file(t->format, -1, INT64_MIN, position, position, 0) < 0) {
            fail(t, "The sound could not seek to that position.");
            return 0;
        }
    }
    avcodec_flush_buffers(t->codec);
    if (seconds >= t->duration) finish(t);
    return 1;
}

/* takes up a new generation; 0 while there is none to play */
static int follow_generation(AudioTrack *t) {
    pthread_mutex_lock(&t->lock);
    uint64_t generation = t->wanted_generation;
    double seconds = t->wanted_seconds;
    pthread_mutex_unlock(&t->lock);
    if (!generation) return 0;
    if (generation != t->generation) {
        audio_output_reset(t->output, generation);
        t->running = 0;
        t->generation = generation;
        if (!restart(t, seconds)) return 0;
    }
    follow_running(t);
    return 1;
}

static int resampler_matches(AudioTrack *t, const AVFrame *frame) {
    return t->resampler && t->resampler_rate == frame->sample_rate && t->resampler_format == frame->format &&
           !av_channel_layout_compare(&t->resampler_layout, &frame->ch_layout);
}

static int prepare_resampler(AudioTrack *t, const AVFrame *frame) {
    if (resampler_matches(t, frame)) return 1;
    swr_free(&t->resampler);
    AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
    if (swr_alloc_set_opts2(&t->resampler, &stereo, AV_SAMPLE_FMT_FLT, RATE, &frame->ch_layout, frame->format,
                            frame->sample_rate, 0, NULL) < 0 ||
        swr_init(t->resampler) < 0) {
        swr_free(&t->resampler);
        return 0;
    }
    av_channel_layout_uninit(&t->resampler_layout);
    if (av_channel_layout_copy(&t->resampler_layout, &frame->ch_layout) < 0) {
        swr_free(&t->resampler);
        return 0;
    }
    t->resampler_rate = frame->sample_rate;
    t->resampler_format = frame->format;
    return 1;
}

/* queues the part of a decoded frame that lies between the cursor and the end */
static int play_frame(AudioTrack *t, const AVFrame *frame) {
    if (!prepare_resampler(t, frame)) {
        fail(t, "The sound could not be converted for the speakers.");
        return 0;
    }
    double pts = frame->best_effort_timestamp == AV_NOPTS_VALUE
                     ? t->cursor
                     : frame->best_effort_timestamp * av_q2d(t->time_base) - t->start;
    /* the first sample out of the resampler is older than this frame by its delay */
    double first = pts - (double)swr_get_delay(t->resampler, RATE) / RATE;
    int capacity = swr_get_out_samples(t->resampler, frame->nb_samples);
    if (capacity < 0) return 0;
    if (capacity > t->sample_capacity) {
        float *grown = realloc(t->samples, (size_t)capacity * 2 * sizeof(float));
        if (!grown) {
            fail(t, "Out of memory while playing sound.");
            return 0;
        }
        t->samples = grown;
        t->sample_capacity = capacity;
    }
    uint8_t *out = (uint8_t *)t->samples;
    int got = swr_convert(t->resampler, &out, capacity, (const uint8_t **)frame->extended_data, frame->nb_samples);
    if (got < 0) {
        fail(t, "The sound could not be converted for the speakers.");
        return 0;
    }
    /* samples before the cursor are before the seek target or already queued; after the end,
       nothing plays */
    long skip = (long)fmax(0, ceil((t->cursor - first) * RATE - 0.001));
    long keep = (long)fmin(got, fmax(0, floor((t->duration - first) * RATE + 0.001)));
    if (skip >= keep) return 1;
    if (first > t->cursor + 1.0 / RATE && !pad_to(t, first)) return 0;
    if (!put(t, t->samples + skip * 2, (size_t)(keep - skip))) return 0;
    if (t->cursor >= t->duration - 1.0 / RATE) finish(t);
    return 1;
}

/* one step of decoding; 0 when there is nothing to do until the clock asks for something new */
static int decode_step(AudioTrack *t, AVPacket *packet, AVFrame *frame) {
    int result = avcodec_receive_frame(t->codec, frame);
    if (result == AVERROR(EAGAIN)) {
        for (;;) {
            result = av_read_frame(t->format, packet);
            if (result == AVERROR_EOF) {
                avcodec_send_packet(t->codec, NULL);
                t->ended = 1;
                return 1;
            }
            if (result < 0) {
                if (!atomic_load(&t->closing)) fail(t, "The sound could not be read.");
                return 0;
            }
            if (packet->stream_index != t->stream) {
                av_packet_unref(packet);
                continue;
            }
            result = avcodec_send_packet(t->codec, packet);
            av_packet_unref(packet);
            if (result < 0 && result != AVERROR(EAGAIN)) {
                if (result != AVERROR_INVALIDDATA || ++t->bad_packets >= BAD_PACKET_LIMIT) {
                    fail(t, "The sound could not be decoded.");
                    return 0;
                }
            } else {
                t->bad_packets = 0;
            }
            return 1;
        }
    }
    if (result == AVERROR_EOF) {
        /* the sound ended before the video: silence keeps the clock going to the end */
        if (pad_to(t, t->duration)) finish(t);
        return 1;
    }
    if (result < 0) {
        fail(t, "The sound could not be decoded.");
        return 0;
    }
    int played = play_frame(t, frame);
    av_frame_unref(frame);
    return played || superseded(t);
}

static void *worker(void *opaque) {
    AudioTrack *t = opaque;
    AVPacket *packet = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    if (!packet || !frame) fail(t, "Out of memory while playing sound.");
    while (!atomic_load(&t->closing)) {
        pthread_mutex_lock(&t->lock);
        int failed = t->failed;
        pthread_mutex_unlock(&t->lock);
        if (failed || !follow_generation(t) || t->finished) {
            wait_for_change(t, 0);
            continue;
        }
        if (!decode_step(t, packet, frame) && !superseded(t)) wait_for_change(t, 0);
    }
    av_frame_free(&frame);
    av_packet_free(&packet);
    return NULL;
}

AudioTrack *audio_track_open(const char *path, double duration_seconds, char *error, size_t error_size) {
    error[0] = 0;
    AudioTrack *t = calloc(1, sizeof(*t));
    if (!t) {
        snprintf(error, error_size, "Out of memory while opening the sound.");
        return NULL;
    }
    pthread_mutex_init(&t->lock, NULL);
    pthread_cond_init(&t->changed, NULL);
    t->duration = duration_seconds;
    t->format = avformat_alloc_context();
    if (!t->format) {
        snprintf(error, error_size, "Out of memory while opening the sound.");
        goto failed;
    }
    t->format->interrupt_callback = (AVIOInterruptCB){interrupted, t};
    if (avformat_open_input(&t->format, path, NULL, NULL) < 0 || avformat_find_stream_info(t->format, NULL) < 0) {
        snprintf(error, error_size, "The sound could not be read.");
        goto failed;
    }
    t->stream = av_find_best_stream(t->format, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
    /* no sound at all is not an error: the video plays on the system clock */
    if (t->stream < 0) goto failed;
    for (unsigned i = 0; i < t->format->nb_streams; i++)
        if ((int)i != t->stream) t->format->streams[i]->discard = AVDISCARD_ALL;
    AVStream *stream = t->format->streams[t->stream];
    t->time_base = stream->time_base;
    t->start = t->format->start_time == AV_NOPTS_VALUE ? 0 : (double)t->format->start_time / AV_TIME_BASE;
    const AVCodec *codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!codec) {
        snprintf(error, error_size, "This kind of sound can't be played.");
        goto failed;
    }
    t->codec = avcodec_alloc_context3(codec);
    if (!t->codec || avcodec_parameters_to_context(t->codec, stream->codecpar) < 0 ||
        avcodec_open2(t->codec, codec, NULL) < 0) {
        snprintf(error, error_size, "The sound decoder could not start.");
        goto failed;
    }
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
    swr_free(&t->resampler);
    av_channel_layout_uninit(&t->resampler_layout);
    free(t->samples);
    avcodec_free_context(&t->codec);
    avformat_close_input(&t->format);
    pthread_cond_destroy(&t->changed);
    pthread_mutex_destroy(&t->lock);
    free(t);
}

void audio_track_want(AudioTrack *t, uint64_t generation, double seconds, int running) {
    pthread_mutex_lock(&t->lock);
    if (generation != t->wanted_generation) {
        t->wanted_generation = generation;
        t->wanted_seconds = seconds;
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
    status->played = output.played;
    status->underruns = output.underruns;
    pthread_mutex_lock(&t->lock);
    status->failed = t->failed || output.failed;
    snprintf(status->error, sizeof(status->error), "%s", t->failed ? t->error : output.error);
    pthread_mutex_unlock(&t->lock);
}
