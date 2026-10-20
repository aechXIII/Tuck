#include "mix.h"

#include <math.h>
#include <string.h>

int mix_piece_valid(const MixPiece *p) {
    return p->voice >= 0 && isfinite(p->start) && isfinite(p->end) && p->end > p->start &&
           isfinite(p->source_in) && p->source_in >= 0 && isfinite(p->gain) && p->gain >= 0 &&
           isfinite(p->fade_in) && p->fade_in >= 0 && isfinite(p->fade_out) && p->fade_out >= 0 &&
           isfinite(p->loop_start) && p->loop_start >= 0 && isfinite(p->loop_span) && p->loop_span >= 0;
}

/* linear ramps that never overlap, so the lower one is the level, as the export's afade gives */
double mix_piece_level(const MixPiece *p, double t) {
    double level = 1;
    double local = t - p->start;
    double remaining = p->end - t;
    if (p->fade_in > 0 && local < p->fade_in) level = fmin(level, fmax(0, local) / p->fade_in);
    if (p->fade_out > 0 && remaining < p->fade_out) level = fmin(level, fmax(0, remaining) / p->fade_out);
    return p->gain * level;
}

double mix_piece_source(const MixPiece *p, double t) {
    double local = t - p->start;
    if (p->loop_span <= 0) return p->source_in + local;
    double into = p->source_in - p->loop_start + local;
    return p->loop_start + fmod(fmax(0, into), p->loop_span);
}

/* the frame of the block at or after timeline second `t` */
static size_t frame_at(double start, double t, size_t frames) {
    double frame = ceil((t - start) * MIX_RATE - 1e-6);
    if (frame <= 0) return 0;
    return frame >= (double)frames ? frames : (size_t)frame;
}

static int add_piece(const MixPiece *p, double start, size_t frames, MixRead read, void *opaque, float *out,
                     float *scratch) {
    size_t first = frame_at(start, p->start, frames);
    size_t last = frame_at(start, p->end, frames);
    while (first < last) {
        double t = start + (double)first / MIX_RATE;
        double source = mix_piece_source(p, t);
        size_t run = last - first;
        /* a read stays inside the file's loop span; the wrap starts a new read */
        if (p->loop_span > 0) {
            double left = p->loop_start + p->loop_span - source;
            size_t until_wrap = (size_t)fmax(1, ceil(left * MIX_RATE - 1e-6));
            if (until_wrap < run) run = until_wrap;
        }
        memset(scratch, 0, run * 2 * sizeof(float));
        if (!read(opaque, p->voice, source, scratch, run)) return 0;
        for (size_t i = 0; i < run; i++) {
            float level = (float)mix_piece_level(p, t + (double)i / MIX_RATE);
            out[(first + i) * 2] += scratch[i * 2] * level;
            out[(first + i) * 2 + 1] += scratch[i * 2 + 1] * level;
        }
        first += run;
    }
    return 1;
}

int mix_render(const Mix *mix, double start, size_t frames, MixRead read, void *opaque, float *out,
               float *scratch) {
    memset(out, 0, frames * 2 * sizeof(float));
    double end = start + (double)frames / MIX_RATE;
    for (size_t i = 0; i < mix->count; i++) {
        const MixPiece *p = &mix->pieces[i];
        if (p->end <= start || p->start >= end) continue;
        if (!add_piece(p, start, frames, read, opaque, out, scratch)) return 0;
    }
    return 1;
}
