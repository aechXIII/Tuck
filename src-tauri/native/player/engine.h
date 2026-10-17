/* The native player as one opaque object. Times are seconds on the caller's monotonic clock, so
   the rules can be tested without waiting. There is no decoder or audio output yet: the caller
   reports each presented frame, and until there is audio the clock runs on monotonic time. */
#ifndef TUCK_PLAYER_ENGINE_H
#define TUCK_PLAYER_ENGINE_H

#include <stdint.h>

typedef struct TuckPlayer TuckPlayer;

typedef struct TuckPlayerStatus {
    double monotonic_seconds;
    double position_seconds;
    double duration_seconds;
    uint64_t generation;
    uint64_t seek_request_id;
    uint64_t confirmed_seek_request_id;
    int32_t paused;
    int32_t seek_pending;
    int32_t ended;
} TuckPlayerStatus;

/* NULL unless the duration is a positive finite number */
TuckPlayer *tuck_player_create(double duration_seconds, double now);
void tuck_player_destroy(TuckPlayer *player);

void tuck_player_play(TuckPlayer *player, double now);
void tuck_player_pause(TuckPlayer *player, double now);
/* 0 when the request ID is not newer than the last one or the position is outside the video */
int tuck_player_seek(TuckPlayer *player, uint64_t request_id, double seconds, double now);
/* the frame for `generation` is on screen; only the current generation confirms a seek */
void tuck_player_frame_presented(TuckPlayer *player, uint64_t generation, double now);
void tuck_player_status(TuckPlayer *player, double now, TuckPlayerStatus *status);

#endif
