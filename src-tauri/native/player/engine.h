/* The native player as one opaque object. Times are seconds on the caller's monotonic clock, so
   the rules can be tested without waiting. The caller reports each presented frame. Without
   sound the clock runs on monotonic time; with sound it runs on what the listener has heard. */
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
    /* media seconds per second of playing */
    double rate;
} TuckPlayerStatus;

/* the editor's slowest and fastest playback speeds */
#define TUCK_PLAYER_RATE_MIN 0.25
#define TUCK_PLAYER_RATE_MAX 4.0

/* NULL unless the duration is a positive finite number */
TuckPlayer *tuck_player_create(double duration_seconds, double now);
void tuck_player_destroy(TuckPlayer *player);

void tuck_player_play(TuckPlayer *player, double now);
void tuck_player_pause(TuckPlayer *player, double now);
/* 0 when the request ID is not newer than the last one or the position is outside the video */
int tuck_player_seek(TuckPlayer *player, uint64_t request_id, double seconds, double now);
/* Plays `rate` media seconds per second from here on. A new rate starts a new generation at the
   current position, held until its first frame is shown, so sound and picture restart together
   at that rate. 0 when the rate is outside TUCK_PLAYER_RATE_MIN to TUCK_PLAYER_RATE_MAX. */
int tuck_player_set_rate(TuckPlayer *player, double rate, double now);
/* The timeline is `duration` seconds long from now on, as edits change it; a position past the new
   end moves to the end, which counts as played to the end. 0 unless positive and finite. */
int tuck_player_set_duration(TuckPlayer *player, double duration, double now);
/* Starts a new generation at the current position, as a new rate does, so sound and picture
   start together again; used when sound is added to a video that played without it. Nothing
   changes at the end. */
void tuck_player_restart(TuckPlayer *player, double now);
/* the frame for `generation` is on screen; only the current generation confirms a seek */
void tuck_player_frame_presented(TuckPlayer *player, uint64_t generation, double now);
/* From now on the clock follows the sound device instead of monotonic time, or goes back to
   monotonic time from where the sound left it (when the device fails). */
void tuck_player_follow_sound(TuckPlayer *player, int on, double now);
/* the device has played `seconds` of `generation` since that generation started */
void tuck_player_sound_played(TuckPlayer *player, uint64_t generation, double seconds, double now);
/* the clock has been running on sound for longer than `limit` seconds without hearing any more of
   it: nothing is taking the sound, so it should go back to monotonic time */
int tuck_player_sound_stalled(TuckPlayer *player, double now, double limit);
void tuck_player_status(TuckPlayer *player, double now, TuckPlayerStatus *status);

#endif
