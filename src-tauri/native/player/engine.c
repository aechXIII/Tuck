#include "engine.h"

#include <math.h>
#include <stdlib.h>

#include "playback_state.h"
#include "seek_request.h"

struct TuckPlayer {
    double duration;
    PlaybackClock clock;
    SeekRequest seeks;
    PreviewState preview;
    uint64_t generation;
    /* what the page asked for; the clock itself also stops while a seek frame is pending */
    int playing;
    int ended;
    /* media seconds per second of playing */
    double rate;
    /* seconds played since the last clock reset, and when that was last brought up to date */
    double played;
    double updated_at;
    /* played comes from the sound device instead of monotonic time */
    int sound;
    /* when the clock last started running or heard more sound */
    double heard_at;
    int was_running;
};

static int running(const TuckPlayer *player) {
    return player->playing && !player->preview.pending && !player->ended;
}

static void hold_clock(TuckPlayer *player, int held) {
    clock_pause(&player->clock, held);
}

static void played_to(TuckPlayer *player, double played) {
    player->played = played;
    clock_update(&player->clock, player->played);
    if (clock_source(&player->clock) >= player->duration) {
        /* playback stops on the last frame, as the HTML player does */
        player->ended = 1;
        player->playing = 0;
        hold_clock(player, 1);
        player->clock.frozen = player->duration;
    }
}

static void advance(TuckPlayer *player, double now) {
    if (!player->sound && running(player) && isfinite(now) && now > player->updated_at)
        played_to(player, player->played + (now - player->updated_at) * player->rate);
    if (isfinite(now) && now > player->updated_at) player->updated_at = now;
}

/* after every change: a clock that just started running starts waiting for sound from now */
static void note_running(TuckPlayer *player, double now) {
    int now_running = running(player);
    if (now_running && !player->was_running && isfinite(now)) player->heard_at = now;
    player->was_running = now_running;
}

/* a new position: new generation, clock held on it until its first frame is shown */
static void restart_at(TuckPlayer *player, double seconds) {
    player->generation++;
    clock_reset(&player->clock, seconds, player->generation);
    hold_clock(player, 1);
    player->played = 0;
    player->ended = 0;
    preview_begin(&player->preview, player->generation);
}

TuckPlayer *tuck_player_create(double duration_seconds, double now) {
    if (!isfinite(duration_seconds) || duration_seconds <= 0 || !isfinite(now)) return NULL;
    TuckPlayer *player = calloc(1, sizeof(*player));
    if (!player) return NULL;
    player->duration = duration_seconds;
    player->rate = 1;
    player->updated_at = now;
    restart_at(player, 0);
    return player;
}

void tuck_player_destroy(TuckPlayer *player) {
    free(player);
}

void tuck_player_play(TuckPlayer *player, double now) {
    advance(player, now);
    /* playing again after the end starts over, like the HTML player */
    if (player->ended) restart_at(player, 0);
    player->playing = 1;
    if (!player->preview.pending) hold_clock(player, 0);
    note_running(player, now);
}

void tuck_player_pause(TuckPlayer *player, double now) {
    advance(player, now);
    player->playing = 0;
    hold_clock(player, 1);
    note_running(player, now);
}

int tuck_player_seek(TuckPlayer *player, uint64_t request_id, double seconds, double now) {
    if (!isfinite(seconds) || seconds < 0 || seconds > player->duration) return 0;
    advance(player, now);
    if (!seek_request_accept(&player->seeks, request_id, player->generation + 1)) return 0;
    restart_at(player, seconds);
    note_running(player, now);
    return 1;
}

int tuck_player_set_rate(TuckPlayer *player, double rate, double now) {
    if (!isfinite(rate) || rate < TUCK_PLAYER_RATE_MIN || rate > TUCK_PLAYER_RATE_MAX) return 0;
    advance(player, now);
    if (rate == player->rate) return 1;
    double position = clock_source(&player->clock);
    player->rate = rate;
    /* the end stays the end; anywhere else starts again from the same spot at the new rate */
    if (!player->ended) restart_at(player, position);
    note_running(player, now);
    return 1;
}

int tuck_player_set_duration(TuckPlayer *player, double duration, double now) {
    if (!isfinite(duration) || duration <= 0) return 0;
    advance(player, now);
    player->duration = duration;
    if (clock_source(&player->clock) >= duration) {
        restart_at(player, duration);
        player->ended = 1;
        player->playing = 0;
        player->clock.frozen = duration;
    }
    note_running(player, now);
    return 1;
}

void tuck_player_restart(TuckPlayer *player, double now) {
    advance(player, now);
    if (!player->ended) restart_at(player, clock_source(&player->clock));
    note_running(player, now);
}

void tuck_player_frame_presented(TuckPlayer *player, uint64_t generation, double now) {
    advance(player, now);
    if (!preview_complete(&player->preview, RENDER_SUBMITTED, generation)) return;
    seek_request_confirm(&player->seeks, generation);
    /* the clock starts from the moment the new position is visible */
    if (player->playing) {
        player->updated_at = now;
        hold_clock(player, 0);
    }
    note_running(player, now);
}

void tuck_player_follow_sound(TuckPlayer *player, int on, double now) {
    advance(player, now);
    player->sound = on != 0;
}

void tuck_player_sound_played(TuckPlayer *player, uint64_t generation, double seconds, double now) {
    advance(player, now);
    /* sound from an older position, or heard after a pause took effect, doesn't move the clock */
    if (!player->sound || generation != player->generation || !running(player)) return;
    if (isfinite(seconds) && seconds > player->played) {
        played_to(player, seconds);
        if (isfinite(now)) player->heard_at = now;
    }
    note_running(player, now);
}

int tuck_player_sound_stalled(TuckPlayer *player, double now, double limit) {
    advance(player, now);
    note_running(player, now);
    return player->sound && running(player) && isfinite(now) && now - player->heard_at > limit;
}

void tuck_player_status(TuckPlayer *player, double now, TuckPlayerStatus *status) {
    advance(player, now);
    status->monotonic_seconds = player->updated_at;
    status->position_seconds = clock_source(&player->clock);
    status->duration_seconds = player->duration;
    status->generation = player->generation;
    status->seek_request_id = player->seeks.requested;
    status->confirmed_seek_request_id = player->seeks.confirmed;
    status->paused = !player->playing;
    status->seek_pending = player->preview.pending;
    status->ended = player->ended;
    status->rate = player->rate;
}
