/* Tests for the native player core, run from the Rust test suite through
   tuck_player_test_failures() so they run wherever the app's tests do. */
#include <math.h>
#include <stdio.h>

#include "../audio_timing.h"
#include "../engine.h"
#include "../framebuffer_cache.h"
#include "../lut_blend.h"
#include "../playback_state.h"
#include "../seek_request.h"

static int failures;

#define CHECK(condition)                                                        \
    do {                                                                        \
        if (!(condition)) {                                                     \
            failures++;                                                         \
            fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
        }                                                                       \
    } while (0)

static int close_to(double a, double b) {
    return fabs(a - b) < 1e-9;
}

static void source_delta(void) {
    const double cases[][3] = {
        {19.163333333333334, 19.17, -6.666666666667},
        {2.0, 21.166666666666668, -19166.666666666668},
        {2.0, 40.333333333333336, -38333.333333333336},
        {12.0, 42.2, -30200.0},
        {5.003333333333333, 5.0, 3.333333333333},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i)
        CHECK(fabs(playback_source_delta_ms(cases[i][0], cases[i][1]) - cases[i][2]) < 1e-7);
    PlaybackClock seek = {0};
    clock_reset(&seek, 4.6, 1);
    clock_update(&seek, 0.75);
    CHECK(fabs(playback_source_delta_ms(5.1, clock_source(&seek)) + 250.0) < 1e-7);
}

static float source[PCM_CAPACITY * 2], result[PCM_CAPACITY * 2];

static void pcm_queue(void) {
    PcmQueue q = {0};
    for (size_t i = 0; i < PCM_CAPACITY * 2; i++) source[i] = (float)i;
    pcm_reset(&q, 7);
    CHECK(pcm_write(&q, source, PCM_CAPACITY, 7) == PCM_CAPACITY);
    CHECK(pcm_write(&q, source, 1, 7) == 0);
    CHECK(pcm_read(&q, result, 23) == 23);
    for (int i = 0; i < 46; i++) CHECK(result[i] == source[i]);
    CHECK(pcm_write(&q, source, 23, 7) == 23);
    CHECK(pcm_read(&q, result, PCM_CAPACITY) == PCM_CAPACITY);
    CHECK(result[0] == source[46]);
    CHECK(result[(PCM_CAPACITY - 23) * 2] == source[0]);
    pcm_reset(&q, 8);
    CHECK(q.count == 0);
    CHECK(pcm_write(&q, source, 20, 7) == 0);
    CHECK(pcm_write(&q, source, 20, 8) == 20);
    pcm_reset(&q, 9);
    pcm_note_underrun(&q, 7);
    CHECK(q.late_debt == 7);
    CHECK(pcm_write(&q, source, 5, 9) == 5 && q.count == 0 && q.late_debt == 2);
    CHECK(pcm_write(&q, source + 10, 6, 9) == 6 && q.count == 4 && q.late_debt == 0);
    CHECK(pcm_read(&q, result, 4) == 4 && result[0] == source[14]);
    CHECK(q.late_dropped == 7);
    pcm_note_underrun(&q, 4);
    pcm_reset(&q, 10);
    CHECK(q.late_debt == 0);
}

static void capacities(void) {
    CHECK(playback_video_capacity(60) == 14);
    CHECK(playback_video_capacity(300) == 40);
    CHECK(playback_video_capacity(360) == 40);
    CHECK(playback_audio_prebuffer(1920) == 4800);
    CHECK(playback_audio_prebuffer(4800) == 4800);
    CHECK(playback_audio_prebuffer(0) == 0);
    CHECK(playback_audio_prebuffer(4801) == 0);
}

static void clock_and_preview(void) {
    PreviewState preview = {0};
    preview_begin(&preview, 7);
    CHECK(preview_needs_frame(&preview, 0, 0));
    CHECK(!preview_needs_frame(&preview, 1, 7));
    CHECK(!preview_complete(&preview, RENDER_DEFERRED, 7));
    CHECK(preview.pending && !preview_needs_frame(&preview, 1, 7));
    CHECK(!preview_complete(&preview, RENDER_SUBMITTED, 6));
    CHECK(!preview_complete(&preview, RENDER_FAILED, 7));
    CHECK(preview.pending);
    CHECK(preview_complete(&preview, RENDER_SUBMITTED, 7));
    CHECK(!preview.pending);

    PlaybackClock c = {0};
    clock_reset(&c, 5.25, 8);
    clock_update(&c, 0.125);
    CHECK(close_to(clock_source(&c), 5.375));
    clock_pause(&c, 1);
    clock_update(&c, 0.9);
    CHECK(close_to(clock_source(&c), 5.375));
    clock_pause(&c, 0);
    clock_update(&c, 0.25);
    CHECK(close_to(clock_source(&c), 5.5));
    clock_update(&c, 0.2);
    CHECK(close_to(clock_source(&c), 5.5));
    double elapsed = c.elapsed;
    clock_reset(&c, 1.0, 9);
    CHECK(c.generation == 9 && clock_source(&c) == 1.0);
    CHECK(c.elapsed == elapsed);
    CHECK(!frame_current(8, 9) && frame_current(9, 9));

    /* a seek holds the clock until its own generation's frame is shown */
    clock_pause(&c, 1);
    clock_reset(&c, 8.2, 10);
    preview_begin(&preview, 10);
    clock_update(&c, .194);
    CHECK(clock_source(&c) == 8.2);
    CHECK(!preview_complete(&preview, RENDER_DEFERRED, 10));
    CHECK(!preview_complete(&preview, RENDER_SUBMITTED, 9));
    CHECK(preview.pending && c.paused);
    if (preview_complete(&preview, RENDER_SUBMITTED, 10)) clock_pause(&c, 0);
    clock_update(&c, .01);
    CHECK(!preview.pending && !c.paused && close_to(clock_source(&c), 8.21));
}

static void seek_requests(void) {
    SeekRequest state = {0};
    CHECK(seek_request_accept(&state, 1, 2));
    CHECK(state.requested == 1 && state.confirmed == 0);
    CHECK(seek_request_accept(&state, 2, 3));
    /* the older seek's frame must not confirm the newer request */
    CHECK(!seek_request_confirm(&state, 2));
    CHECK(state.requested == 2 && state.confirmed == 0);
    CHECK(seek_request_confirm(&state, 3));
    CHECK(state.confirmed == 2);
    CHECK(!seek_request_accept(&state, 1, 4));
    CHECK(!seek_request_accept(&state, 2, 4));
    CHECK(!seek_request_accept(&state, 0, 4));
    CHECK(!seek_request_accept(&state, SEEK_REQUEST_MAX + 1, 4));
    for (unsigned i = 3; i <= 100; i++) CHECK(seek_request_accept(&state, i, i + 1));
    CHECK(!seek_request_confirm(&state, 100));
    CHECK(state.confirmed == 2);
    CHECK(seek_request_confirm(&state, 101));
    CHECK(state.confirmed == 100);
}

static void audio_timing(void) {
    AudioTimingInput t = {.submitted = 48000, .queued = 480, .buffered = 240, .delay = 480,
                          .rate_num = 1, .rate_denom = 48000, .report_ns = 1000000000, .now_ns = 1000000000};
    double seconds = 0;
    CHECK(audio_timing_position(&t, &seconds) && close_to(seconds, .975));
    t.now_ns += 5000000;
    CHECK(audio_timing_position(&t, &seconds) && close_to(seconds, .980));
    t.rate_denom = 96000;
    t.delay = 960;
    CHECK(audio_timing_position(&t, &seconds) && close_to(seconds, .980));
    t.delay = -960;
    CHECK(audio_timing_position(&t, &seconds) && close_to(seconds, .990));
    t.submitted = 240;
    CHECK(audio_timing_position(&t, &seconds) && seconds == 0);
    t.queued = 0;
    t.buffered = 0;
    t.delay = 0;
    t.now_ns += 20000000;
    CHECK(audio_timing_position(&t, &seconds) && seconds == .005);
    t.rate_denom = 0;
    CHECK(!audio_timing_position(&t, &seconds));
    t.rate_denom = 48000;
    t.report_ns = 0;
    CHECK(!audio_timing_position(&t, &seconds));
    t.report_ns = 2000000000;
    t.now_ns = 1000000000;
    CHECK(!audio_timing_position(&t, &seconds));
    t.report_ns = 1000000000;
    t.now_ns = 1300000000;
    CHECK(!audio_timing_position(&t, &seconds));
}

static TuckPlayerStatus status_at(TuckPlayer *player, double now) {
    TuckPlayerStatus status = {0};
    tuck_player_status(player, now, &status);
    return status;
}

static void engine(void) {
    CHECK(!tuck_player_create(0, 0));
    CHECK(!tuck_player_create(NAN, 0));
    TuckPlayer *player = tuck_player_create(10, 100);
    CHECK(player != NULL);
    if (!player) return;

    /* opening waits for the first frame, paused at the start */
    TuckPlayerStatus s = status_at(player, 100);
    CHECK(s.paused && s.seek_pending && s.position_seconds == 0 && s.generation == 1);
    tuck_player_frame_presented(player, 1, 100);
    CHECK(!status_at(player, 100).seek_pending);

    /* the clock runs only while playing */
    tuck_player_play(player, 101);
    CHECK(close_to(status_at(player, 102.5).position_seconds, 1.5));
    tuck_player_pause(player, 103);
    CHECK(close_to(status_at(player, 105).position_seconds, 2));
    tuck_player_play(player, 106);
    CHECK(close_to(status_at(player, 106.5).position_seconds, 2.5));

    /* a playing seek holds the clock until its frame is shown, then runs from that moment */
    CHECK(tuck_player_seek(player, 1, 4, 107));
    s = status_at(player, 107.2);
    CHECK(s.seek_pending && !s.paused && s.position_seconds == 4 && s.seek_request_id == 1 && s.confirmed_seek_request_id == 0);
    tuck_player_frame_presented(player, s.generation, 107.25);
    s = status_at(player, 107.5);
    CHECK(!s.seek_pending && s.confirmed_seek_request_id == 1 && close_to(s.position_seconds, 4.25));

    /* rapid seeks: only the newest request is confirmed, by its own frame */
    CHECK(tuck_player_seek(player, 2, 1, 108));
    uint64_t older = status_at(player, 108).generation;
    CHECK(tuck_player_seek(player, 3, 6, 108));
    tuck_player_frame_presented(player, older, 108.1);
    s = status_at(player, 108.1);
    CHECK(s.seek_pending && s.confirmed_seek_request_id == 1 && s.position_seconds == 6);
    tuck_player_frame_presented(player, s.generation, 108.1);
    CHECK(status_at(player, 108.1).confirmed_seek_request_id == 3);

    /* stale or repeated request IDs and positions outside the video are refused */
    CHECK(!tuck_player_seek(player, 3, 2, 109));
    CHECK(!tuck_player_seek(player, 2, 2, 109));
    CHECK(!tuck_player_seek(player, 4, -1, 109));
    CHECK(!tuck_player_seek(player, 4, 10.5, 109));
    CHECK(!tuck_player_seek(player, 4, NAN, 109));

    /* playback stops on the last frame and starts over when played again */
    s = status_at(player, 120);
    CHECK(s.ended && s.paused && s.position_seconds == 10);
    tuck_player_play(player, 121);
    s = status_at(player, 121);
    CHECK(!s.ended && !s.paused && s.seek_pending && s.position_seconds == 0);
    tuck_player_frame_presented(player, s.generation, 121);
    CHECK(close_to(status_at(player, 122).position_seconds, 1));

    /* a monotonic clock that goes backwards never moves the position back */
    double before = status_at(player, 123).position_seconds;
    CHECK(status_at(player, 122.5).position_seconds == before);
    tuck_player_destroy(player);
}

/* a new speed restarts at the same spot and the clock then runs at that speed */
static void playback_rate(void) {
    TuckPlayer *player = tuck_player_create(10, 100);
    CHECK(player != NULL);
    if (!player) return;
    tuck_player_frame_presented(player, 1, 100);
    CHECK(status_at(player, 100).rate == 1);
    CHECK(!tuck_player_set_rate(player, 0, 100));
    CHECK(!tuck_player_set_rate(player, 0.2, 100));
    CHECK(!tuck_player_set_rate(player, 4.5, 100));
    CHECK(!tuck_player_set_rate(player, NAN, 100));
    CHECK(status_at(player, 100).rate == 1);

    tuck_player_play(player, 101);
    CHECK(tuck_player_set_rate(player, 2, 102));
    TuckPlayerStatus s = status_at(player, 102.5);
    /* held on the spot it was playing until the new generation's frame is shown */
    CHECK(s.generation == 2 && s.seek_pending && !s.paused && close_to(s.position_seconds, 1) && s.rate == 2);
    tuck_player_frame_presented(player, 2, 103);
    CHECK(close_to(status_at(player, 104).position_seconds, 3));
    /* the same speed again changes nothing */
    CHECK(tuck_player_set_rate(player, 2, 104));
    CHECK(status_at(player, 104).generation == 2);

    /* slower than normal, paused: the spot stays and playing later runs at a quarter */
    tuck_player_pause(player, 104);
    CHECK(tuck_player_set_rate(player, 0.25, 105));
    s = status_at(player, 105);
    CHECK(s.generation == 3 && s.paused && close_to(s.position_seconds, 3));
    tuck_player_frame_presented(player, 3, 105);
    tuck_player_play(player, 106);
    CHECK(close_to(status_at(player, 108).position_seconds, 3.5));

    /* at the end it stays at the end */
    tuck_player_set_rate(player, 4, 108);
    tuck_player_frame_presented(player, 4, 108);
    tuck_player_play(player, 108);
    CHECK(status_at(player, 110).ended);
    uint64_t ended_generation = status_at(player, 110).generation;
    CHECK(tuck_player_set_rate(player, 1, 110));
    s = status_at(player, 110);
    CHECK(s.ended && s.generation == ended_generation && s.position_seconds == 10);
    tuck_player_destroy(player);
}

/* with sound, the clock follows what the listener has heard instead of the monotonic clock */
static void sound_clock(void) {
    TuckPlayer *player = tuck_player_create(10, 100);
    CHECK(player != NULL);
    if (!player) return;
    tuck_player_follow_sound(player, 1, 100);
    tuck_player_frame_presented(player, 1, 100);
    tuck_player_play(player, 101);

    /* only heard sound moves the clock; time passing without it doesn't */
    CHECK(status_at(player, 101.5).position_seconds == 0);
    tuck_player_sound_played(player, 1, 0.5, 101.6);
    CHECK(close_to(status_at(player, 105).position_seconds, 0.5));
    /* the device's report never moves the clock back */
    tuck_player_sound_played(player, 1, 0.4, 105.1);
    CHECK(close_to(status_at(player, 105.1).position_seconds, 0.5));

    /* a seek's sound counts only once its frame is shown, and old sound never counts */
    CHECK(tuck_player_seek(player, 1, 4, 106));
    TuckPlayerStatus s = status_at(player, 106);
    tuck_player_sound_played(player, s.generation - 1, 2, 106.1);
    tuck_player_sound_played(player, s.generation, 0.1, 106.1);
    CHECK(status_at(player, 106.1).position_seconds == 4);
    tuck_player_frame_presented(player, s.generation, 106.2);
    CHECK(status_at(player, 106.3).position_seconds == 4);
    tuck_player_sound_played(player, s.generation, 0.25, 106.5);
    CHECK(close_to(status_at(player, 106.5).position_seconds, 4.25));

    /* sound heard after a pause took effect doesn't move the paused clock */
    tuck_player_pause(player, 107);
    tuck_player_sound_played(player, s.generation, 0.3, 107.1);
    CHECK(close_to(status_at(player, 108).position_seconds, 4.25));
    tuck_player_play(player, 108);
    tuck_player_sound_played(player, s.generation, 0.5, 108.2);
    CHECK(close_to(status_at(player, 108.2).position_seconds, 4.5));

    /* heard sound reaching the end stops playback there */
    tuck_player_sound_played(player, s.generation, 6.5, 110);
    s = status_at(player, 110);
    CHECK(s.ended && s.paused && s.position_seconds == 10);

    /* when the device fails, the clock carries on in monotonic time from where the sound left it */
    tuck_player_play(player, 111);
    s = status_at(player, 111);
    tuck_player_frame_presented(player, s.generation, 111);
    tuck_player_sound_played(player, s.generation, 1, 111.5);
    tuck_player_follow_sound(player, 0, 112);
    CHECK(close_to(status_at(player, 113).position_seconds, 2));
    tuck_player_destroy(player);
}

/* sound that stops being heard while the clock runs is a stall, so the clock can leave it */
static void sound_stall(void) {
    TuckPlayer *player = tuck_player_create(10, 100);
    CHECK(player != NULL);
    if (!player) return;
    tuck_player_follow_sound(player, 1, 100);
    /* a clock waiting for its first frame, or paused, never stalls */
    tuck_player_play(player, 100);
    CHECK(!tuck_player_sound_stalled(player, 105, 1.5));
    tuck_player_frame_presented(player, 1, 105);
    /* running, it waits for sound from the moment it started */
    CHECK(!tuck_player_sound_stalled(player, 106.4, 1.5));
    CHECK(tuck_player_sound_stalled(player, 106.6, 1.5));
    /* and from the last sound it heard */
    tuck_player_sound_played(player, 1, 0.2, 106.7);
    CHECK(!tuck_player_sound_stalled(player, 108, 1.5));
    CHECK(tuck_player_sound_stalled(player, 108.3, 1.5));
    tuck_player_pause(player, 108.4);
    CHECK(!tuck_player_sound_stalled(player, 120, 1.5));
    /* playing again starts the wait over */
    tuck_player_play(player, 120);
    CHECK(!tuck_player_sound_stalled(player, 121, 1.5));
    CHECK(tuck_player_sound_stalled(player, 121.6, 1.5));
    /* a seek waits for its frame first, then for its own sound */
    CHECK(tuck_player_seek(player, 1, 5, 122));
    CHECK(!tuck_player_sound_stalled(player, 124, 1.5));
    tuck_player_frame_presented(player, status_at(player, 124).generation, 124);
    CHECK(!tuck_player_sound_stalled(player, 125, 1.5));
    CHECK(tuck_player_sound_stalled(player, 125.6, 1.5));
    /* on monotonic time there is no sound to wait for */
    tuck_player_follow_sound(player, 0, 126);
    CHECK(!tuck_player_sound_stalled(player, 140, 1.5));
    tuck_player_destroy(player);
}

/* the preview's LUT at a strength is the table blended with an identity table, as the export
   bakes it; R changes fastest */
static void lut_strength(void) {
    float table[2 * 2 * 2 * 3], out[2 * 2 * 2 * 3];
    for (int i = 0; i < 24; i++) table[i] = 0.25f;
    lut_blend(out, table, 2, 1);
    CHECK(out[0] == 0.25f && out[23] == 0.25f);
    lut_blend(out, table, 2, 0);
    /* sample 1 is r=1, g=0, b=0; sample 6 is r=0, g=1, b=1 */
    CHECK(out[3] == 1 && out[4] == 0 && out[5] == 0);
    CHECK(out[18] == 0 && out[19] == 1 && out[20] == 1);
    lut_blend(out, table, 2, 0.5);
    CHECK(fabs(out[3] - 0.625) < 1e-6 && fabs(out[4] - 0.125) < 1e-6);
}

/* GTK hands the same framebuffer every frame; a new wrapper is made only when it changes */
static void framebuffer_cache(void) {
    FramebufferCacheState state = {0};
    CHECK(!framebuffer_cache_matches(&state, 0, 1920, 1080));
    framebuffer_cache_created(&state, 0, 1920, 1080);
    for (unsigned frame = 0; frame < 100000; ++frame) CHECK(framebuffer_cache_matches(&state, 0, 1920, 1080));
    CHECK(state.wraps == 1);
    CHECK(!framebuffer_cache_matches(&state, 3, 1920, 1080));
    CHECK(!framebuffer_cache_matches(&state, 0, 960, 1080));
    CHECK(!framebuffer_cache_matches(&state, 0, 1920, 640));
    framebuffer_cache_reset(&state);
    CHECK(!framebuffer_cache_matches(&state, 0, 1920, 1080));
    CHECK(state.wraps == 1);
    framebuffer_cache_created(&state, 3, 960, 640);
    CHECK(framebuffer_cache_matches(&state, 3, 960, 640) && state.wraps == 2);
}

int tuck_player_test_failures(void) {
    failures = 0;
    source_delta();
    pcm_queue();
    capacities();
    clock_and_preview();
    seek_requests();
    audio_timing();
    engine();
    playback_rate();
    sound_clock();
    sound_stall();
    lut_strength();
    framebuffer_cache();
    return failures;
}
