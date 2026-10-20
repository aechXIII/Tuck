#include "playback_state.h"

#include <math.h>
#include <string.h>

void pcm_note_underrun(PcmQueue *queue, size_t frames) {
    queue->late_debt += frames;
}

void pcm_reset(PcmQueue *queue, uint64_t generation) {
    queue->read = 0;
    queue->count = 0;
    queue->generation = generation;
    queue->late_debt = 0;
}

size_t pcm_write(PcmQueue *queue, const float *samples, size_t frames, uint64_t generation) {
    if (generation != queue->generation) return 0;
    size_t dropped = frames < queue->late_debt ? frames : queue->late_debt;
    queue->late_debt -= dropped;
    queue->late_dropped += dropped;
    samples += dropped * 2;
    frames -= dropped;
    if (frames > PCM_CAPACITY - queue->count) frames = PCM_CAPACITY - queue->count;
    for (size_t i = 0; i < frames; i++) {
        size_t slot = (queue->read + queue->count + i) % PCM_CAPACITY;
        memcpy(queue->samples + slot * 2, samples + i * 2, 2 * sizeof(float));
    }
    queue->count += frames;
    return frames + dropped;
}

size_t pcm_read(PcmQueue *queue, float *samples, size_t frames) {
    if (frames > queue->count) frames = queue->count;
    for (size_t i = 0; i < frames; i++)
        memcpy(samples + i * 2, queue->samples + ((queue->read + i) % PCM_CAPACITY) * 2, 2 * sizeof(float));
    queue->read = (queue->read + frames) % PCM_CAPACITY;
    queue->count -= frames;
    return frames;
}

void clock_reset(PlaybackClock *clock, double source, uint64_t generation) {
    clock->origin = source;
    clock->device = 0;
    clock->frozen = source;
    clock->generation = generation;
}

void clock_update(PlaybackClock *clock, double device) {
    if (clock->paused || !isfinite(device) || device < clock->device) return;
    clock->elapsed += device - clock->device;
    clock->device = device;
}

void clock_pause(PlaybackClock *clock, int paused) {
    if (paused && !clock->paused) clock->frozen = clock->origin + clock->device;
    clock->paused = paused != 0;
}

double clock_source(const PlaybackClock *clock) {
    return clock->paused ? clock->frozen : clock->origin + clock->device;
}

double playback_source_delta_ms(double video_source, double master_source) {
    return (video_source - master_source) * 1000.0;
}

int frame_current(uint64_t frame_generation, uint64_t generation) {
    return frame_generation == generation;
}

/* 200 ms of frames at the requested cadence plus two, never more than 40 GPU snapshots */
unsigned playback_video_capacity(int fps) {
    unsigned capacity = (unsigned)ceil(fps * 0.2) + 2;
    return capacity > 40 ? 40 : capacity;
}

double playback_keep_step(double window, double frame_interval) {
    if (!(window > 0)) return 0;
    double step = frame_interval > 0 ? window - frame_interval : window;
    return step > 0 ? step : 0;
}

double playback_next_keep(double next, double time, double step) {
    if (!(step > 0)) return next;
    return next + (floor((time - next) / step + 1e-5) + 1) * step;
}

/* 100 ms of audio before the endpoint starts; endpoints wanting more than that are refused */
unsigned playback_audio_prebuffer(unsigned endpoint_frames) {
    return endpoint_frames && endpoint_frames <= 4800 ? 4800 : 0;
}

void preview_begin(PreviewState *state, uint64_t generation) {
    state->generation = generation;
    state->pending = 1;
}

int preview_needs_frame(const PreviewState *state, int held, uint64_t held_generation) {
    return state->pending && (!held || !frame_current(held_generation, state->generation));
}

int preview_complete(PreviewState *state, RenderOutcome outcome, uint64_t frame_generation) {
    if (!state->pending || outcome != RENDER_SUBMITTED || !frame_current(frame_generation, state->generation))
        return 0;
    state->pending = 0;
    return 1;
}
