/* One video in the native player: the clock core decides where playback is, the decoder fills a
   queue for that position, and a render thread shows the frame for the clock's time. A seek's clock
   holds until its own frame has been presented, so the page never runs ahead of the picture. */
#include "tuck_video.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

#include "decoder.h"
#include "render.h"

/* playing, a frame due within this much counts as due now */
#define FRAME_SLACK 0.001

struct TuckVideo {
    pthread_mutex_t lock;
    pthread_cond_t wake;
    TuckPlayer *clock;
    Decoder *decoder;
    Renderer *renderer;
    pthread_t render_thread;
    int render_started;
    atomic_int stopping;
    /* under lock */
    uint64_t decoder_generation;
    uint64_t presented;
    int failed;
    char error[192];
    int signalled;
};

static double now_seconds(void) {
#ifdef _WIN32
    static LARGE_INTEGER frequency;
    LARGE_INTEGER counter;
    if (!frequency.QuadPart) QueryPerformanceFrequency(&frequency);
    QueryPerformanceCounter(&counter);
    return (double)counter.QuadPart / (double)frequency.QuadPart;
#else
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (double)now.tv_sec + now.tv_nsec / 1e9;
#endif
}

static void wake_render(void *opaque) {
    TuckVideo *v = opaque;
    pthread_mutex_lock(&v->lock);
    v->signalled = 1;
    pthread_cond_signal(&v->wake);
    pthread_mutex_unlock(&v->lock);
}

static AVBufferRef *hook_device(void *opaque) {
    return renderer_device(((TuckVideo *)opaque)->renderer);
}

static AVFrame *hook_keep(void *opaque, const AVFrame *frame) {
    return renderer_keep(((TuckVideo *)opaque)->renderer, frame);
}

/* under lock: every new clock generation (open, seek, start over) asks the decoder for it */
static void follow_clock(TuckVideo *v, const TuckPlayerStatus *status) {
    if (status->generation == v->decoder_generation) return;
    v->decoder_generation = status->generation;
    decoder_seek(v->decoder, status->position_seconds, status->generation);
}

static void fail_locked(TuckVideo *v, const char *message) {
    if (!v->failed) snprintf(v->error, sizeof(v->error), "%s", message);
    v->failed = 1;
}

static void wait_for_work(TuckVideo *v, double seconds) {
    struct timespec until;
    clock_gettime(CLOCK_REALTIME, &until);
    long nanoseconds = until.tv_nsec + (long)(seconds * 1e9);
    until.tv_sec += nanoseconds / 1000000000L;
    until.tv_nsec = nanoseconds % 1000000000L;
    pthread_mutex_lock(&v->lock);
    if (!v->signalled && !atomic_load(&v->stopping)) pthread_cond_timedwait(&v->wake, &v->lock, &until);
    v->signalled = 0;
    pthread_mutex_unlock(&v->lock);
}

static void *render_main(void *opaque) {
    TuckVideo *v = opaque;
    DecodedFrame shown = {0};
    int redraw = 0;
    while (!atomic_load(&v->stopping)) {
        TuckPlayerStatus status;
        pthread_mutex_lock(&v->lock);
        tuck_player_status(v->clock, now_seconds(), &status);
        follow_clock(v, &status);
        int failed = v->failed;
        pthread_mutex_unlock(&v->lock);
        if (failed) {
            wait_for_work(v, 0.1);
            continue;
        }
        DecodedFrame next = {0};
        if (decoder_take(v->decoder, status.position_seconds + FRAME_SLACK, status.generation, status.seek_pending,
                         &next)) {
            decoded_frame_clear(&shown);
            shown = next;
            redraw = 1;
        }
        if (renderer_resized(v->renderer)) redraw = 1;
        if (redraw && shown.frame) {
            RenderOutcome outcome = renderer_draw(v->renderer, &shown);
            pthread_mutex_lock(&v->lock);
            if (outcome == RENDER_SUBMITTED) {
                tuck_player_frame_presented(v->clock, shown.generation, now_seconds());
                v->presented++;
                redraw = 0;
            } else if (outcome == RENDER_FAILED) {
                fail_locked(v, renderer_error(v->renderer));
            }
            pthread_mutex_unlock(&v->lock);
        }
        int running = !status.paused || status.seek_pending;
        wait_for_work(v, running ? 0.001 : 0.016);
    }
    decoded_frame_clear(&shown);
    return NULL;
}

int tuck_video_abi(void) {
    return TUCK_VIDEO_ABI;
}

TuckVideo *tuck_video_open(const TuckVideoOpen *open, char *error, size_t error_size) {
    if (!open || !open->path) {
        snprintf(error, error_size, "No video was given.");
        return NULL;
    }
    TuckVideo *v = calloc(1, sizeof(*v));
    if (!v) {
        snprintf(error, error_size, "Out of memory while opening the video.");
        return NULL;
    }
    pthread_mutex_init(&v->lock, NULL);
    pthread_cond_init(&v->wake, NULL);
    v->clock = tuck_player_create(open->duration_seconds, now_seconds());
    if (!v->clock) {
        snprintf(error, error_size, "The video length is not valid.");
        goto failed;
    }
    v->renderer = renderer_open(open->window, error, error_size);
    if (!v->renderer) goto failed;
    DecoderHooks hooks = {
        .opaque = v,
        .device_type = renderer_device_type(),
        .hardware_format = renderer_hardware_format(),
        .device = hook_device,
        .keep = hook_keep,
        .wake = wake_render,
    };
    v->decoder = decoder_open(open->path, &hooks, error, error_size);
    if (!v->decoder) goto failed;
    decoder_set_cadence(v->decoder, renderer_refresh_interval(v->renderer));
    if (pthread_create(&v->render_thread, NULL, render_main, v) != 0) {
        snprintf(error, error_size, "The preview could not start its drawing thread.");
        goto failed;
    }
    v->render_started = 1;
    return v;
failed:
    tuck_video_close(v);
    return NULL;
}

void tuck_video_close(TuckVideo *v) {
    if (!v) return;
    atomic_store(&v->stopping, 1);
    wake_render(v);
    if (v->render_started) pthread_join(v->render_thread, NULL);
    /* queued frames hold GPU textures, so the decoder goes before the renderer */
    decoder_close(v->decoder);
    renderer_close(v->renderer);
    tuck_player_destroy(v->clock);
    pthread_cond_destroy(&v->wake);
    pthread_mutex_destroy(&v->lock);
    free(v);
}

static void after_command(TuckVideo *v) {
    TuckPlayerStatus status;
    tuck_player_status(v->clock, now_seconds(), &status);
    follow_clock(v, &status);
    v->signalled = 1;
    pthread_cond_signal(&v->wake);
}

void tuck_video_play(TuckVideo *v) {
    pthread_mutex_lock(&v->lock);
    tuck_player_play(v->clock, now_seconds());
    after_command(v);
    pthread_mutex_unlock(&v->lock);
}

void tuck_video_pause(TuckVideo *v) {
    pthread_mutex_lock(&v->lock);
    tuck_player_pause(v->clock, now_seconds());
    after_command(v);
    pthread_mutex_unlock(&v->lock);
}

int tuck_video_seek(TuckVideo *v, uint64_t request_id, double seconds) {
    pthread_mutex_lock(&v->lock);
    int accepted = tuck_player_seek(v->clock, request_id, seconds, now_seconds());
    if (accepted) after_command(v);
    pthread_mutex_unlock(&v->lock);
    return accepted;
}

void tuck_video_status(TuckVideo *v, TuckVideoStatus *status) {
    memset(status, 0, sizeof(*status));
    DecoderInfo info = {0};
    decoder_info(v->decoder, &info);
    pthread_mutex_lock(&v->lock);
    tuck_player_status(v->clock, now_seconds(), &status->clock);
    status->presented = v->presented;
    status->failed = v->failed || info.failed;
    snprintf(status->error, sizeof(status->error), "%s", v->failed ? v->error : info.error);
    pthread_mutex_unlock(&v->lock);
    status->frame_rate = info.frame_rate;
    status->hardware = info.hardware;
    snprintf(status->decoder, sizeof(status->decoder), "%s", info.name);
}
