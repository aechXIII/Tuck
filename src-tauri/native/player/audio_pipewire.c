/* Sound on Linux through a PipeWire stream. libpipewire is opened at run time, so the player
   library still loads on a system without it and the video plays on the system clock there.
   Only header-inline SPA helpers are compiled in; every libpipewire call goes through `pw`.

   The queue, counters and stream state belong to the PipeWire loop thread and are touched only
   with the loop locked. The stream is inactive while paused or still priming, so its process
   callback only runs while sound should be heard. */
#include "audio_output.h"

#include <dlfcn.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>
#include <spa/pod/builder.h>

#include "audio_timing.h"
#include "playback_state.h"

/* matches pw_time from libpipewire 1.x; older libraries fill only its first fields */
typedef struct PipewireTime {
    int64_t now;
    struct spa_fraction rate;
    uint64_t ticks;
    int64_t delay;
    uint64_t queued;
    uint64_t buffered;
    uint32_t queued_buffers;
    uint32_t avail_buffers;
    uint64_t size;
} PipewireTime;

static struct {
    void (*init)(int *argc, char **argv[]);
    struct pw_thread_loop *(*loop_new)(const char *name, const struct spa_dict *props);
    int (*loop_start)(struct pw_thread_loop *loop);
    void (*loop_stop)(struct pw_thread_loop *loop);
    void (*loop_destroy)(struct pw_thread_loop *loop);
    void (*loop_lock)(struct pw_thread_loop *loop);
    void (*loop_unlock)(struct pw_thread_loop *loop);
    void (*loop_signal)(struct pw_thread_loop *loop, bool wait_for_accept);
    int (*loop_timed_wait)(struct pw_thread_loop *loop, int wait_max_sec);
    struct pw_loop *(*loop_get_loop)(struct pw_thread_loop *loop);
    struct pw_properties *(*properties_new)(const char *key, ...);
    struct pw_stream *(*stream_new_simple)(struct pw_loop *loop, const char *name, struct pw_properties *props,
                                           const struct pw_stream_events *events, void *data);
    int (*stream_connect)(struct pw_stream *stream, enum pw_direction direction, uint32_t target_id,
                          enum pw_stream_flags flags, const struct spa_pod **params, uint32_t n_params);
    void (*stream_destroy)(struct pw_stream *stream);
    struct pw_buffer *(*stream_dequeue_buffer)(struct pw_stream *stream);
    int (*stream_queue_buffer)(struct pw_stream *stream, struct pw_buffer *buffer);
    int (*stream_set_active)(struct pw_stream *stream, bool active);
    int (*stream_flush)(struct pw_stream *stream, bool drain);
    /* 0.3.50 and newer; older ones only have stream_get_time */
    int (*stream_get_time_n)(struct pw_stream *stream, struct pw_time *time, size_t size);
    int (*stream_get_time)(struct pw_stream *stream, struct pw_time *time);
} pw;

static pthread_once_t load_once = PTHREAD_ONCE_INIT;
static int loaded;

static void load_pipewire(void) {
    /* never closed: libpipewire keeps global state once initialized */
    void *library = dlopen("libpipewire-0.3.so.0", RTLD_NOW | RTLD_LOCAL);
    if (!library) return;
#define FIND(field, name) *(void **)&pw.field = dlsym(library, name)
    FIND(init, "pw_init");
    FIND(loop_new, "pw_thread_loop_new");
    FIND(loop_start, "pw_thread_loop_start");
    FIND(loop_stop, "pw_thread_loop_stop");
    FIND(loop_destroy, "pw_thread_loop_destroy");
    FIND(loop_lock, "pw_thread_loop_lock");
    FIND(loop_unlock, "pw_thread_loop_unlock");
    FIND(loop_signal, "pw_thread_loop_signal");
    FIND(loop_timed_wait, "pw_thread_loop_timed_wait");
    FIND(loop_get_loop, "pw_thread_loop_get_loop");
    FIND(properties_new, "pw_properties_new");
    FIND(stream_new_simple, "pw_stream_new_simple");
    FIND(stream_connect, "pw_stream_connect");
    FIND(stream_destroy, "pw_stream_destroy");
    FIND(stream_dequeue_buffer, "pw_stream_dequeue_buffer");
    FIND(stream_queue_buffer, "pw_stream_queue_buffer");
    FIND(stream_set_active, "pw_stream_set_active");
    FIND(stream_flush, "pw_stream_flush");
    FIND(stream_get_time_n, "pw_stream_get_time_n");
    FIND(stream_get_time, "pw_stream_get_time");
#undef FIND
    if (!pw.init || !pw.loop_new || !pw.loop_start || !pw.loop_stop || !pw.loop_destroy || !pw.loop_lock ||
        !pw.loop_unlock || !pw.loop_signal || !pw.loop_timed_wait || !pw.loop_get_loop || !pw.properties_new ||
        !pw.stream_new_simple || !pw.stream_connect || !pw.stream_destroy || !pw.stream_dequeue_buffer ||
        !pw.stream_queue_buffer || !pw.stream_set_active || !pw.stream_flush ||
        (!pw.stream_get_time_n && !pw.stream_get_time))
        return;
    pw.init(NULL, NULL);
    loaded = 1;
}

struct AudioOutput {
    struct pw_thread_loop *loop;
    struct pw_stream *stream;
    enum pw_stream_state state;
    int started, closing;
    PcmQueue pcm;
    float gain;
    int paused, active, finished;
    /* frames handed to PipeWire in this generation */
    uint64_t submitted;
    double played;
    uint64_t underruns;
    char error[160];
};

static int64_t monotonic_ns(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (int64_t)now.tv_sec * 1000000000 + now.tv_nsec;
}

static void set_error(AudioOutput *o, const char *message, int code) {
    if (o->error[0]) return;
    if (code)
        snprintf(o->error, sizeof(o->error), "%s (%s).", message, strerror(code < 0 ? -code : code));
    else
        snprintf(o->error, sizeof(o->error), "%s.", message);
}

/* with the loop locked: what the listener has heard so far, from PipeWire's report on the stream */
static void update_played(AudioOutput *o) {
    if (o->paused || !o->active || o->state != PW_STREAM_STATE_STREAMING) return;
    PipewireTime t = {0};
    int result = pw.stream_get_time_n ? pw.stream_get_time_n(o->stream, (struct pw_time *)&t, sizeof(t))
                                      : pw.stream_get_time(o->stream, (struct pw_time *)&t);
    if (result < 0) return;
    AudioTimingInput input = {
        .submitted = o->submitted,
        .queued = t.queued,
        .buffered = t.buffered,
        .delay = t.delay,
        .report_ns = t.now,
        .now_ns = monotonic_ns(),
        .rate_num = t.rate.num,
        .rate_denom = t.rate.denom,
    };
    double seconds;
    if (audio_timing_position(&input, &seconds) && seconds > o->played) o->played = seconds;
}

/* with the loop locked */
static void activate(AudioOutput *o) {
    if (o->paused || o->active || o->error[0]) return;
    if (o->pcm.count < PCM_PRIME_FRAMES && !(o->finished && o->pcm.count)) return;
    int result = pw.stream_set_active(o->stream, true);
    if (result < 0) {
        set_error(o, "The sound device could not start", result);
        return;
    }
    o->active = 1;
}

/* with the loop locked */
static void deactivate(AudioOutput *o) {
    update_played(o);
    if (!o->active) return;
    int result = pw.stream_set_active(o->stream, false);
    if (result < 0) set_error(o, "The sound device could not stop", result);
    o->active = 0;
}

static void on_state(void *opaque, enum pw_stream_state old, enum pw_stream_state state, const char *error) {
    (void)old;
    AudioOutput *o = opaque;
    o->state = state;
    if (!o->closing && state == PW_STREAM_STATE_ERROR)
        snprintf(o->error, sizeof(o->error), "The sound device failed: %.120s", error ? error : "unknown error");
    if (!o->closing && state == PW_STREAM_STATE_UNCONNECTED && o->started && !o->error[0])
        snprintf(o->error, sizeof(o->error), "The sound device went away.");
    pw.loop_signal(o->loop, false);
}

static void on_process(void *opaque) {
    AudioOutput *o = opaque;
    if (o->paused || o->closing) return;
    struct pw_buffer *buffer = pw.stream_dequeue_buffer(o->stream);
    if (!buffer) return;
    struct spa_data *data = &buffer->buffer->datas[0];
    if (!buffer->buffer->n_datas || !data->data || !data->chunk) {
        set_error(o, "The sound device gave an unusable buffer", EIO);
        return;
    }
    uint32_t capacity = data->maxsize / (2 * sizeof(float));
    uint32_t frames = buffer->requested ? (uint32_t)SPA_MIN(buffer->requested, capacity) : SPA_MIN(512u, capacity);
    float *samples = data->data;
    size_t got = pcm_read(&o->pcm, samples, frames);
    for (size_t i = 0; i < got * 2; i++) samples[i] *= o->gain;
    if (got < frames) {
        memset(samples + got * 2, 0, (frames - got) * 2 * sizeof(float));
        /* the end of a finished generation is not a gap */
        if (!o->finished) {
            pcm_note_underrun(&o->pcm, frames - got);
            o->underruns++;
        }
    }
    data->chunk->offset = 0;
    data->chunk->stride = 2 * sizeof(float);
    data->chunk->size = frames * 2 * sizeof(float);
    buffer->size = frames;
    int result = pw.stream_queue_buffer(o->stream, buffer);
    if (result < 0) {
        set_error(o, "Sound could not be queued", result);
        return;
    }
    o->submitted += frames;
    update_played(o);
}

static const struct pw_stream_events stream_events = {
    PW_VERSION_STREAM_EVENTS,
    .state_changed = on_state,
    .process = on_process,
};

AudioOutput *audio_output_open(char *error, size_t error_size) {
    pthread_once(&load_once, load_pipewire);
    if (!loaded) {
        snprintf(error, error_size, "Sound needs PipeWire, which this system doesn't have.");
        return NULL;
    }
    AudioOutput *o = calloc(1, sizeof(*o));
    if (!o) {
        snprintf(error, error_size, "Out of memory while opening the sound device.");
        return NULL;
    }
    o->gain = 1;
    o->paused = 1;
    o->state = PW_STREAM_STATE_UNCONNECTED;
    o->loop = pw.loop_new("tuck-sound", NULL);
    if (!o->loop) {
        set_error(o, "The sound thread could not be created", 0);
        goto failed;
    }
    int result = pw.loop_start(o->loop);
    if (result < 0) {
        set_error(o, "The sound thread could not start", result);
        goto failed;
    }
    o->started = 1;
    pw.loop_lock(o->loop);
    o->stream = pw.stream_new_simple(
        pw.loop_get_loop(o->loop), "Tuck",
        /* WirePlumber remembers a stream's volume by application; its own id keeps the webview's
           stream, which the page mutes by setting its volume to 0, from silencing this one */
        pw.properties_new(PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY, "Playback", PW_KEY_MEDIA_ROLE, "Movie",
                          PW_KEY_APP_NAME, "Tuck", PW_KEY_APP_ID, "com.tuck.app.player", PW_KEY_NODE_LATENCY,
                          "512/48000", NULL),
        &stream_events, o);
    if (o->stream) {
        uint8_t pod[1024];
        struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(pod, sizeof(pod));
        struct spa_audio_info_raw info = {
            .format = SPA_AUDIO_FORMAT_F32,
            .rate = 48000,
            .channels = 2,
            .position = {SPA_AUDIO_CHANNEL_FL, SPA_AUDIO_CHANNEL_FR},
        };
        const struct spa_pod *params[] = {spa_format_audio_raw_build(&builder, SPA_PARAM_EnumFormat, &info)};
        result = pw.stream_connect(o->stream, PW_DIRECTION_OUTPUT, PW_ID_ANY,
                                   PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS | PW_STREAM_FLAG_INACTIVE,
                                   params, 1);
        if (result < 0) set_error(o, "The sound device could not be reached", result);
        while (!o->error[0] && o->state != PW_STREAM_STATE_PAUSED) {
            if (pw.loop_timed_wait(o->loop, 5) != 0) set_error(o, "The sound device did not answer", ETIMEDOUT);
        }
    } else {
        set_error(o, "The sound stream could not be created", 0);
    }
    int ok = !o->error[0];
    pw.loop_unlock(o->loop);
    if (ok) return o;
failed:
    snprintf(error, error_size, "%s", o->error);
    audio_output_close(o);
    return NULL;
}

void audio_output_close(AudioOutput *o) {
    if (!o) return;
    if (o->started) pw.loop_lock(o->loop);
    o->closing = 1;
    if (o->stream) pw.stream_destroy(o->stream);
    o->stream = NULL;
    if (o->started) {
        pw.loop_unlock(o->loop);
        pw.loop_stop(o->loop);
    }
    if (o->loop) pw.loop_destroy(o->loop);
    free(o);
}

size_t audio_output_write(AudioOutput *o, const float *samples, size_t frames, uint64_t generation) {
    pw.loop_lock(o->loop);
    size_t written = o->error[0] ? 0 : pcm_write(&o->pcm, samples, frames, generation);
    activate(o);
    pw.loop_unlock(o->loop);
    return written;
}

void audio_output_finish(AudioOutput *o, uint64_t generation) {
    pw.loop_lock(o->loop);
    if (generation == o->pcm.generation) {
        o->finished = 1;
        activate(o);
    }
    pw.loop_unlock(o->loop);
}

void audio_output_reset(AudioOutput *o, uint64_t generation) {
    pw.loop_lock(o->loop);
    o->paused = 1;
    deactivate(o);
    /* sound PipeWire still holds belongs to the old position */
    if (!o->error[0]) {
        int result = pw.stream_flush(o->stream, false);
        if (result < 0) set_error(o, "The sound device could not be cleared", result);
    }
    pcm_reset(&o->pcm, generation);
    o->finished = 0;
    o->submitted = 0;
    o->played = 0;
    pw.loop_unlock(o->loop);
}

void audio_output_pause(AudioOutput *o, int paused) {
    pw.loop_lock(o->loop);
    if (paused) {
        deactivate(o);
        o->paused = 1;
    } else {
        o->paused = 0;
        activate(o);
    }
    pw.loop_unlock(o->loop);
}

void audio_output_volume(AudioOutput *o, float gain) {
    if (!isfinite(gain)) return;
    pw.loop_lock(o->loop);
    o->gain = fminf(1, fmaxf(0, gain));
    pw.loop_unlock(o->loop);
}

int audio_output_failed(AudioOutput *o) {
    pw.loop_lock(o->loop);
    int failed = o->error[0] != 0;
    pw.loop_unlock(o->loop);
    return failed;
}

void audio_output_status(AudioOutput *o, AudioOutputStatus *status) {
    pw.loop_lock(o->loop);
    update_played(o);
    status->generation = o->pcm.generation;
    status->played = o->played;
    status->underruns = o->underruns;
    status->failed = o->error[0] != 0;
    snprintf(status->error, sizeof(status->error), "%s", o->error);
    pw.loop_unlock(o->loop);
}
