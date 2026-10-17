/* Audible position of a 48 kHz output stream from what was submitted, what is still queued or
   buffered and the device's reported delay, extrapolated from the report time. Reports older than
   250 ms or from the future are refused rather than guessed. */
#ifndef TUCK_AUDIO_TIMING_H
#define TUCK_AUDIO_TIMING_H

#include <stdint.h>

typedef struct AudioTimingInput {
    uint64_t submitted, queued, buffered;
    int64_t delay, report_ns, now_ns;
    uint32_t rate_num, rate_denom;
} AudioTimingInput;

static inline int audio_timing_position(const AudioTimingInput *t, double *seconds) {
    if (!t->rate_num || !t->rate_denom || t->report_ns <= 0 || t->now_ns < t->report_ns ||
        t->now_ns - t->report_ns > 250000000)
        return 0;
    double elapsed = (t->now_ns - t->report_ns) / 1e9;
    double delay = (t->delay > 0 ? t->delay : 0) * (double)t->rate_num / t->rate_denom;
    double position = (double)t->submitted / 48000 - (double)t->queued / 48000 -
                      (double)t->buffered / 48000 - delay + elapsed;
    if (position < 0) position = 0;
    if (position > (double)t->submitted / 48000) position = (double)t->submitted / 48000;
    *seconds = position;
    return 1;
}

#endif
