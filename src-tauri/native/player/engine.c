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
    /* seconds played since the last clock reset, and when that was last brought up to date */
    double played;
    double updated_at;
};

static void hold_clock(TuckPlayer *player, int held) {
    clock_pause(&player->clock, held);
}

static void advance(TuckPlayer *player, double now) {
    int running = player->playing && !player->preview.pending && !player->ended;
    if (running && isfinite(now) && now > player->updated_at) {
        player->played += now - player->updated_at;
        clock_update(&player->clock, player->played);
        if (clock_source(&player->clock) >= player->duration) {
            /* playback stops on the last frame, as the HTML player does */
            player->ended = 1;
            player->playing = 0;
            hold_clock(player, 1);
            player->clock.frozen = player->duration;
        }
    }
    if (isfinite(now) && now > player->updated_at) player->updated_at = now;
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
}

void tuck_player_pause(TuckPlayer *player, double now) {
    advance(player, now);
    player->playing = 0;
    hold_clock(player, 1);
}

int tuck_player_seek(TuckPlayer *player, uint64_t request_id, double seconds, double now) {
    if (!isfinite(seconds) || seconds < 0 || seconds > player->duration) return 0;
    advance(player, now);
    if (!seek_request_accept(&player->seeks, request_id, player->generation + 1)) return 0;
    restart_at(player, seconds);
    return 1;
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
}
