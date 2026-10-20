/* Playback rules shared by every native player backend: the bounded PCM queue, the playback
   clock with its generations, and the pending-frame state that holds a seek until its first frame
   is shown. Plain C with no platform dependencies. */
#ifndef TUCK_PLAYBACK_STATE_H
#define TUCK_PLAYBACK_STATE_H

#include <stddef.h>
#include <stdint.h>

/* 250 ms of 48 kHz stereo; more only adds latency */
#define PCM_CAPACITY 12000
/* sound starts once 100 ms is queued, so a slow first decode can't open with a gap */
#define PCM_PRIME_FRAMES 4800

typedef struct PcmQueue {
    float samples[PCM_CAPACITY * 2];
    size_t read, count;
    uint64_t generation;
    /* frames the device already played as silence; that much late audio is dropped */
    size_t late_debt;
    uint64_t late_dropped;
} PcmQueue;

void pcm_reset(PcmQueue *queue, uint64_t generation);
size_t pcm_write(PcmQueue *queue, const float *samples, size_t frames, uint64_t generation);
size_t pcm_read(PcmQueue *queue, float *samples, size_t frames);
void pcm_note_underrun(PcmQueue *queue, size_t frames);

/* source position = origin + device seconds played since the last reset */
typedef struct PlaybackClock {
    double origin, device, frozen, elapsed;
    uint64_t generation;
    int paused;
} PlaybackClock;

void clock_reset(PlaybackClock *clock, double source, uint64_t generation);
void clock_update(PlaybackClock *clock, double device);
void clock_pause(PlaybackClock *clock, int paused);
double clock_source(const PlaybackClock *clock);
double playback_source_delta_ms(double video_source, double master_source);
int frame_current(uint64_t frame_generation, uint64_t generation);
unsigned playback_video_capacity(int fps);
/* How far apart in video time the decoder keeps frames when one refresh shows `window` seconds of
   video: a source frame less than the window, so whatever the phase between the frames, the keep
   grid and the refreshes, every refresh has a new frame. 0 keeps every frame. */
double playback_keep_step(double window, double frame_interval);
/* the keep grid's next point after a frame kept at `time` */
double playback_next_keep(double next, double time, double step);
unsigned playback_audio_prebuffer(unsigned endpoint_frames);

typedef enum RenderOutcome { RENDER_FAILED = 0, RENDER_SUBMITTED = 1, RENDER_DEFERRED = 2 } RenderOutcome;

typedef struct PreviewState {
    uint64_t generation;
    int pending;
} PreviewState;

void preview_begin(PreviewState *state, uint64_t generation);
int preview_needs_frame(const PreviewState *state, int held, uint64_t held_generation);
int preview_complete(PreviewState *state, RenderOutcome outcome, uint64_t frame_generation);

#endif
