/* One video in the native player: the clock core decides where playback is, the decoder fills a
   queue for that position, and the frame for the clock's time is drawn: by a render thread on
   Windows, from the shell's GL area on Linux. A seek's clock holds until its own frame has been
   drawn, so the page never runs ahead of the picture. With sound, the clock follows what the
   listener has heard, and a seek's sound starts only once its frame is on screen. */
#include "tuck_video.h"

#include <math.h>
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

#include "audio.h"
#include "decoder.h"
#include "edits.h"
#include "lut.h"
#include "playback_state.h"
#include "render.h"

/* playing, a frame due within this much counts as due now */
#define FRAME_SLACK 0.001
/* sound that should be heard but isn't for this long means no speaker takes it (a PipeWire with
   no sound devices, as on desktops whose sound still runs through PulseAudio) */
#define SOUND_STALL_SECONDS 1.5
#define NO_SPEAKER "No speaker is playing the sound."

/* once nothing took the sound, later videos skip it instead of stalling again on their first
   play; the library lives as long as the app */
static atomic_int speakers_missing;

struct TuckVideo {
    pthread_mutex_t lock;
    pthread_cond_t wake;
    TuckPlayer *clock;
    Decoder *decoder;
    double duration;
    /* seconds between display refreshes, and the speed the decoder's frame spacing is set for */
    double interval;
    double decoder_rate;
    atomic_int stopping;
    /* the frame on screen; the render thread's on Windows, the GTK main thread's on Linux */
    DecodedFrame shown;
#ifdef _WIN32
    Renderer *renderer;
    pthread_t render_thread;
    int render_started;
#else
    AVBufferRef *device;
    /* the renderer can't import GPU frames, so kept frames are copied to memory here */
    int download;
#endif
    AudioTrack *audio;
    PreviewLut lut;
    /* under lock */
    /* the LUT changed, so the frame on screen should be drawn again */
    int lut_changed;
    /* the timeline's footage; no segments is the file as it is */
    EditSegment *edits;
    size_t edit_count;
    /* what the decoder was last asked for: its own request number, the clock generation it serves
       and the segment it shows (EDITS_GAP is black); crossing into another segment while playing
       asks the decoder again without holding the clock, a seek holds it until its frame shows */
    uint64_t picture_request;
    uint64_t picture_clock;
    int picture_segment;
    int picture_stale;
    uint64_t presented;
    int failed;
    char error[192];
    int signalled;
    /* TUCK_SOUND_* */
    int sound;
    char sound_error[160];
    uint64_t sound_underruns;
    /* what the sound was last asked for */
    uint64_t sound_generation;
    int sound_running;
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

/* under lock: every new clock generation (open, seek, start over) and every move into another
   segment asks the decoder for the footage under the clock, and the sound is heard only while the
   clock runs */
static void follow_clock(TuckVideo *v, const TuckPlayerStatus *status) {
    int segment = edits_segment_at(v->edits, v->edit_count, status->position_seconds);
    /* playing to the end keeps the last picture, as the HTML player does */
    if (segment == EDITS_GAP && status->ended && v->picture_clock == status->generation) segment = v->picture_segment;
    if (status->generation != v->picture_clock || segment != v->picture_segment || v->picture_stale) {
        v->picture_clock = status->generation;
        v->picture_segment = segment;
        v->picture_stale = 0;
        if (segment != EDITS_GAP) {
            /* faster playback shows frames further apart on the timeline. Slower playback keeps the
               normal spacing: a closer one would let the queue hold more decoder surfaces than the
               GPU pool was made with, and a video up to the display's frame rate still shows every
               frame */
            double rate = fmax(status->rate, 1);
            if (rate != v->decoder_rate) {
                v->decoder_rate = rate;
                decoder_set_cadence(v->decoder, v->interval * rate);
            }
            v->picture_request++;
            decoder_seek(v->decoder, edits_source(v->edits, segment, status->position_seconds), v->picture_request);
        }
    }
    if (v->sound != TUCK_SOUND_PLAYING) return;
    int running = !status->paused && !status->seek_pending && !status->ended;
    if (status->generation == v->sound_generation && running == v->sound_running) return;
    v->sound_generation = status->generation;
    v->sound_running = running;
    audio_track_want(v->audio, status->generation, status->position_seconds, status->rate, running);
}

/* under lock: the clock leaves the sound and carries on in monotonic time */
static void lose_sound(TuckVideo *v, const char *reason, double now) {
    v->sound = TUCK_SOUND_UNAVAILABLE;
    snprintf(v->sound_error, sizeof(v->sound_error), "%s", reason);
    tuck_player_follow_sound(v->clock, 0, now);
    audio_track_want(v->audio, v->sound_generation, 0, 1, 0);
}

/* under lock: tells the clock what the listener has heard; a failed device leaves the clock on
   monotonic time from there */
static void hear(TuckVideo *v, double now) {
    if (v->sound != TUCK_SOUND_PLAYING) return;
    AudioTrackStatus sound;
    audio_track_status(v->audio, &sound);
    v->sound_underruns = sound.underruns;
    if (sound.failed) {
        lose_sound(v, sound.error, now);
        return;
    }
    tuck_player_sound_played(v->clock, sound.generation, sound.played, now);
    if (tuck_player_sound_stalled(v->clock, now, SOUND_STALL_SECONDS)) {
        atomic_store(&speakers_missing, 1);
        lose_sound(v, NO_SPEAKER, now);
    }
}

static void fail_locked(TuckVideo *v, const char *message) {
    if (!v->failed) snprintf(v->error, sizeof(v->error), "%s", message);
    v->failed = 1;
}

/* the clock now, with the decoder asked for any new generation; 0 once the video failed. With a
   later `shown_at`, the position is where the clock will be when the drawn frame reaches the
   screen: a draw's own start time wanders a little after each refresh, and frames due right at
   that moment would then go out on alternate refreshes for a whole run */
static int clock_now(TuckVideo *v, TuckPlayerStatus *status, double shown_at) {
    pthread_mutex_lock(&v->lock);
    double now = now_seconds();
    hear(v, now);
    tuck_player_status(v->clock, now, status);
    if (shown_at > now) status->position_seconds = tuck_player_position_at(v->clock, shown_at);
    follow_clock(v, status);
    int failed = v->failed;
    pthread_mutex_unlock(&v->lock);
    return !failed;
}

/* what the picture should show for the clock's time */
typedef struct Picture {
    int segment;
    uint64_t request;
    uint64_t clock;
    double source;
} Picture;

static Picture picture_now(TuckVideo *v, const TuckPlayerStatus *status) {
    pthread_mutex_lock(&v->lock);
    Picture p = {v->picture_segment, v->picture_request, v->picture_clock,
                 edits_source(v->edits, v->picture_segment, status->position_seconds)};
    pthread_mutex_unlock(&v->lock);
    return p;
}

/* swaps in the frame for the clock's time when the decoder has it, or nothing in a gap; 1 when
   the picture should be drawn again */
static int take_frame(TuckVideo *v, const TuckPlayerStatus *status) {
    Picture p = picture_now(v, status);
    if (p.segment == EDITS_GAP) {
        /* a seek into a gap is shown as soon as the black is */
        if (!v->shown.frame) return status->seek_pending;
        decoded_frame_clear(&v->shown);
        return 1;
    }
    DecodedFrame next = {0};
    /* a seek waits for its own first frame; crossing into a segment shows the last frame until the
       new footage arrives */
    int first = status->seek_pending && p.clock == status->generation;
    if (!decoder_take(v->decoder, p.source + FRAME_SLACK, p.request, first, &next)) return 0;
    decoded_frame_clear(&v->shown);
    v->shown = next;
    return 1;
}

/* the clock generation the picture on screen belongs to, so drawing it can confirm a seek */
static uint64_t shown_clock(TuckVideo *v) {
    pthread_mutex_lock(&v->lock);
    uint64_t clock = 0;
    if (v->picture_segment == EDITS_GAP) clock = v->picture_clock;
    else if (v->shown.frame && v->shown.generation == v->picture_request) clock = v->picture_clock;
    pthread_mutex_unlock(&v->lock);
    return clock;
}

static void drawn(TuckVideo *v, RenderOutcome outcome, const char *error, uint64_t clock) {
    pthread_mutex_lock(&v->lock);
    if (outcome == RENDER_SUBMITTED) {
        double now = now_seconds();
        if (clock) tuck_player_frame_presented(v->clock, clock, now);
        if (v->shown.frame) v->presented++;
        /* a seek's frame is on screen: its sound may start */
        TuckPlayerStatus status;
        tuck_player_status(v->clock, now, &status);
        follow_clock(v, &status);
    } else if (outcome == RENDER_FAILED) {
        fail_locked(v, error);
    }
    pthread_mutex_unlock(&v->lock);
}

static void after_command(TuckVideo *v) {
    TuckPlayerStatus status;
    tuck_player_status(v->clock, now_seconds(), &status);
    follow_clock(v, &status);
    v->signalled = 1;
    pthread_cond_signal(&v->wake);
}

int tuck_video_abi(void) {
    return TUCK_VIDEO_ABI;
}

#ifdef _WIN32

static AVBufferRef *hook_device(void *opaque) {
    return renderer_device(((TuckVideo *)opaque)->renderer);
}

static AVFrame *hook_keep(void *opaque, const AVFrame *frame) {
    return renderer_keep(((TuckVideo *)opaque)->renderer, frame);
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
    int redraw = 0;
    while (!atomic_load(&v->stopping)) {
        TuckPlayerStatus status;
        if (!clock_now(v, &status, 0)) {
            wait_for_work(v, 0.1);
            continue;
        }
        if (take_frame(v, &status)) redraw = 1;
        if (renderer_resized(v->renderer)) redraw = 1;
        pthread_mutex_lock(&v->lock);
        if (v->lut_changed) redraw = 1;
        v->lut_changed = 0;
        pthread_mutex_unlock(&v->lock);
        if (redraw) {
            uint64_t clock = shown_clock(v);
            RenderOutcome outcome = v->shown.frame
                                        ? renderer_draw(v->renderer, &v->shown, preview_lut_current(&v->lut))
                                        : renderer_clear(v->renderer);
            drawn(v, outcome, renderer_error(v->renderer), clock);
            if (outcome == RENDER_SUBMITTED) redraw = 0;
        }
        int running = !status.paused || status.seek_pending;
        wait_for_work(v, running ? 0.001 : 0.016);
    }
    return NULL;
}

static int start_drawing(TuckVideo *v, const TuckVideoOpen *open, DecoderHooks *hooks, char *error,
                         size_t error_size) {
    v->renderer = renderer_open(open->window, error, error_size);
    if (!v->renderer) return 0;
    hooks->device_type = renderer_device_type();
    hooks->hardware_format = renderer_hardware_format();
    hooks->device = hook_device;
    hooks->keep = hook_keep;
    /* frames are copied out of decoder surfaces at once */
    hooks->extra_frames = 2;
    return 1;
}

static double display_interval(TuckVideo *v, const TuckVideoOpen *open) {
    return open->display_interval > 0 ? open->display_interval : renderer_refresh_interval(v->renderer);
}

static int start_thread(TuckVideo *v, char *error, size_t error_size) {
    if (pthread_create(&v->render_thread, NULL, render_main, v) != 0) {
        snprintf(error, error_size, "The preview could not start its drawing thread.");
        return 0;
    }
    v->render_started = 1;
    return 1;
}

static void stop_drawing(TuckVideo *v) {
    if (v->render_started) pthread_join(v->render_thread, NULL);
}

static void close_drawing(TuckVideo *v) {
    renderer_close(v->renderer);
}

#else

static AVBufferRef *hook_device(void *opaque) {
    TuckVideo *v = opaque;
    return v->device ? av_buffer_ref(v->device) : NULL;
}

/* the queue holds the decoder's VAAPI surfaces; with EGL, OpenGL imports them without a copy */
static AVFrame *hook_keep(void *opaque, const AVFrame *frame) {
    (void)opaque;
    return av_frame_clone(frame);
}

/* GLX can't import VAAPI surfaces, so frames are copied to memory ahead of their time on the
   decoder's preparing thread. A copy takes 8 to 10 ms at 1440p on the laptop: on GTK's main thread
   it halved the drawn frame rate, and on the decoder thread it stalled decoding. */
static AVFrame *hook_download(void *opaque, const AVFrame *frame) {
    (void)opaque;
    AVFrame *copy = av_frame_alloc();
    if (copy && av_hwframe_transfer_data(copy, frame, 0) >= 0 && av_frame_copy_props(copy, frame) >= 0) return copy;
    av_frame_free(&copy);
    return NULL;
}

static int start_drawing(TuckVideo *v, const TuckVideoOpen *open, DecoderHooks *hooks, char *error,
                         size_t error_size) {
    (void)error;
    (void)error_size;
    double interval = open->display_interval > 0 ? open->display_interval : 1.0 / 60;
    v->download = open->download_frames != 0;
    /* no GPU decoding is fine: the decoder falls back to software */
    if (av_hwdevice_ctx_create(&v->device, AV_HWDEVICE_TYPE_VAAPI, NULL, NULL, 0) < 0) v->device = NULL;
    hooks->device_type = AV_HWDEVICE_TYPE_VAAPI;
    hooks->hardware_format = AV_PIX_FMT_VAAPI;
    hooks->device = hook_device;
    hooks->keep = hook_keep;
    hooks->prepare = v->download ? hook_download : NULL;
    /* every queued frame, the one on screen, the seek candidate and one being drawn */
    hooks->extra_frames = (int)playback_video_capacity((int)(1.0 / interval + 0.5)) + 4;
    return 1;
}

static double display_interval(TuckVideo *v, const TuckVideoOpen *open) {
    (void)v;
    return open->display_interval > 0 ? open->display_interval : 1.0 / 60;
}

static int start_thread(TuckVideo *v, char *error, size_t error_size) {
    (void)v;
    (void)error;
    (void)error_size;
    return 1;
}

static void stop_drawing(TuckVideo *v) {
    (void)v;
}

static void close_drawing(TuckVideo *v) {
    av_buffer_unref(&v->device);
}

int tuck_video_due(TuckVideo *v, double shown_at) {
    TuckPlayerStatus status;
    if (!clock_now(v, &status, shown_at)) return 0;
    pthread_mutex_lock(&v->lock);
    int lut_changed = v->lut_changed;
    pthread_mutex_unlock(&v->lock);
    Picture p = picture_now(v, &status);
    if (p.segment == EDITS_GAP) return lut_changed || v->shown.frame != NULL || status.seek_pending;
    return lut_changed ||
           decoder_ready(v->decoder, p.source + FRAME_SLACK, p.request, status.seek_pending && p.clock == status.generation);
}

int tuck_video_draw(TuckVideo *v, TuckGlRenderer *renderer, const TuckVideoTarget *target, double shown_at) {
    TuckPlayerStatus status;
    if (!clock_now(v, &status, shown_at)) {
        tuck_gl_renderer_clear(renderer, target);
        return 0;
    }
    take_frame(v, &status);
    pthread_mutex_lock(&v->lock);
    v->lut_changed = 0;
    pthread_mutex_unlock(&v->lock);
    uint64_t clock = shown_clock(v);
    if (!v->shown.frame) {
        tuck_gl_renderer_clear(renderer, target);
        /* black is what a gap shows, so a seek into one is on screen now */
        if (clock) drawn(v, RENDER_SUBMITTED, NULL, clock);
        return 0;
    }
    RenderOutcome outcome = gl_renderer_draw(renderer, &v->shown, target, preview_lut_current(&v->lut));
    drawn(v, outcome, gl_renderer_error(renderer), clock);
    return outcome == RENDER_SUBMITTED;
}

#endif

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
    preview_lut_init(&v->lut);
    v->clock = tuck_player_create(open->duration_seconds, now_seconds());
    v->duration = open->duration_seconds;
    if (!v->clock) {
        snprintf(error, error_size, "The video length is not valid.");
        goto failed;
    }
    DecoderHooks hooks = {.opaque = v, .wake = wake_render};
    if (!start_drawing(v, open, &hooks, error, error_size)) goto failed;
    v->decoder = decoder_open(open->path, &hooks, error, error_size);
    if (!v->decoder) goto failed;
    v->interval = display_interval(v, open);
    v->decoder_rate = 1;
    decoder_set_cadence(v->decoder, v->interval);
    /* a file without sound, or sound that can't play, still shows its picture */
    if (atomic_load(&speakers_missing))
        snprintf(v->sound_error, sizeof(v->sound_error), "%s", NO_SPEAKER);
    else
        v->audio = audio_track_open(open->path, open->duration_seconds, v->sound_error, sizeof(v->sound_error));
    v->sound = v->audio ? TUCK_SOUND_PLAYING : v->sound_error[0] ? TUCK_SOUND_UNAVAILABLE : TUCK_SOUND_NONE;
    if (v->audio) {
        tuck_player_follow_sound(v->clock, 1, now_seconds());
        TuckPlayerStatus status;
        tuck_player_status(v->clock, now_seconds(), &status);
        follow_clock(v, &status);
    }
    if (!start_thread(v, error, error_size)) goto failed;
    return v;
failed:
    tuck_video_close(v);
    return NULL;
}

void tuck_video_close(TuckVideo *v) {
    if (!v) return;
    atomic_store(&v->stopping, 1);
    wake_render(v);
    stop_drawing(v);
    audio_track_close(v->audio);
    decoded_frame_clear(&v->shown);
    /* queued frames hold GPU textures or surfaces, so the decoder goes before the device */
    decoder_close(v->decoder);
    close_drawing(v);
    tuck_player_destroy(v->clock);
    free(v->edits);
    preview_lut_destroy(&v->lut);
    pthread_cond_destroy(&v->wake);
    pthread_mutex_destroy(&v->lock);
    free(v);
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

int tuck_video_rate(TuckVideo *v, double rate) {
    pthread_mutex_lock(&v->lock);
    int accepted = tuck_player_set_rate(v->clock, rate, now_seconds());
    if (accepted) after_command(v);
    pthread_mutex_unlock(&v->lock);
    return accepted;
}

#define MIX_VOICE_LIMIT 256
#define MIX_PIECE_LIMIT 65536

int tuck_video_mix(TuckVideo *v, const TuckMixVoice *voices, int32_t voice_count, const TuckMixPiece *pieces,
                   int32_t piece_count) {
    if (voice_count < 0 || piece_count < 0 || voice_count > MIX_VOICE_LIMIT || piece_count > MIX_PIECE_LIMIT ||
        (voice_count && !voices) || (piece_count && !pieces))
        return 0;
    const char **paths = voice_count ? malloc((size_t)voice_count * sizeof(*paths)) : NULL;
    int *streams = voice_count ? malloc((size_t)voice_count * sizeof(*streams)) : NULL;
    MixPiece *mix = piece_count ? malloc((size_t)piece_count * sizeof(*mix)) : NULL;
    int usable = (!voice_count || (paths && streams)) && (!piece_count || mix);
    for (int32_t i = 0; usable && i < voice_count; i++) {
        usable = voices[i].path != NULL && voices[i].stream >= 0;
        if (usable) {
            paths[i] = voices[i].path;
            streams[i] = voices[i].stream;
        }
    }
    for (int32_t i = 0; usable && i < piece_count; i++) {
        const TuckMixPiece *p = &pieces[i];
        mix[i] = (MixPiece){p->voice, p->start, p->end, p->source_in, p->gain, p->fade_in, p->fade_out, p->loop_start,
                            p->loop_span};
        usable = mix_piece_valid(&mix[i]) && p->voice < voice_count;
    }
    if (usable) {
        pthread_mutex_lock(&v->lock);
        /* a video without sound of its own starts its clock on the mix, from the spot it is at */
        if (!v->audio && voice_count && v->sound == TUCK_SOUND_NONE) {
            v->audio = audio_track_new(v->duration, v->sound_error, sizeof(v->sound_error));
            v->sound = v->audio ? TUCK_SOUND_PLAYING : TUCK_SOUND_UNAVAILABLE;
            if (v->audio) {
                double now = now_seconds();
                tuck_player_follow_sound(v->clock, 1, now);
                tuck_player_restart(v->clock, now);
            }
        }
        /* without a sound device the mix is taken and plays nowhere, as the video's own sound does */
        if (v->audio) usable = audio_track_set_mix(v->audio, paths, streams, (size_t)voice_count, mix, (size_t)piece_count);
        after_command(v);
        pthread_mutex_unlock(&v->lock);
    }
    free(paths);
    free(streams);
    free(mix);
    return usable;
}

#define EDIT_SEGMENT_LIMIT 65536

int tuck_video_edits(TuckVideo *v, const TuckEditSegment *segments, int32_t count, double duration) {
    if (count < 0 || count > EDIT_SEGMENT_LIMIT || (count && !segments)) return 0;
    EditSegment *edits = count ? malloc((size_t)count * sizeof(*edits)) : NULL;
    if (count && !edits) return 0;
    for (int32_t i = 0; i < count; i++)
        edits[i] = (EditSegment){segments[i].start, segments[i].end, segments[i].source_start};
    if (!edits_valid(edits, (size_t)count, duration)) {
        free(edits);
        return 0;
    }
    pthread_mutex_lock(&v->lock);
    free(v->edits);
    v->edits = edits;
    v->edit_count = (size_t)count;
    v->duration = duration;
    /* the same timeline spot may now show other footage */
    v->picture_stale = 1;
    tuck_player_set_duration(v->clock, duration, now_seconds());
    if (v->audio) audio_track_set_duration(v->audio, duration);
    after_command(v);
    pthread_mutex_unlock(&v->lock);
    return 1;
}

/* the frame on screen is drawn again with the new LUT, also while paused */
static void lut_changed(TuckVideo *v) {
    pthread_mutex_lock(&v->lock);
    v->lut_changed = 1;
    v->signalled = 1;
    pthread_cond_signal(&v->wake);
    pthread_mutex_unlock(&v->lock);
}

int tuck_video_lut_table(TuckVideo *v, const float *table, int32_t size) {
    if (!preview_lut_set_table(&v->lut, table, size)) return 0;
    lut_changed(v);
    return 1;
}

void tuck_video_lut_strength(TuckVideo *v, double strength) {
    preview_lut_set_strength(&v->lut, strength);
    lut_changed(v);
}

void tuck_video_volume(TuckVideo *v, double gain) {
    if (v->audio && isfinite(gain)) audio_track_volume(v->audio, (float)gain);
}

void tuck_video_status(TuckVideo *v, TuckVideoStatus *status) {
    memset(status, 0, sizeof(*status));
    DecoderInfo info = {0};
    decoder_info(v->decoder, &info);
    pthread_mutex_lock(&v->lock);
    double now = now_seconds();
    hear(v, now);
    tuck_player_status(v->clock, now, &status->clock);
    status->presented = v->presented;
    status->sound = v->sound;
    status->sound_underruns = v->sound_underruns;
    snprintf(status->sound_error, sizeof(status->sound_error), "%s", v->sound_error);
    status->failed = v->failed || info.failed;
    snprintf(status->error, sizeof(status->error), "%s", v->failed ? v->error : info.error);
    pthread_mutex_unlock(&v->lock);
    status->frame_rate = info.frame_rate;
    status->hardware = info.hardware;
    status->software_reason = info.software_reason;
    snprintf(status->decoder, sizeof(status->decoder), "%s", info.name);
}
