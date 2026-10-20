/* The preview mix: which stretch of which sound plays at each moment of the timeline, and how
   loud. Python compiles it from the same rules as the export (tuck/audio_mix.py); this part only
   sums it, so it needs no FFmpeg and its sample math is tested on its own. */
#ifndef TUCK_MIX_H
#define TUCK_MIX_H

#include <stddef.h>

/* the mix's sample rate; the sound device takes it as it is */
#define MIX_RATE 48000

typedef struct MixPiece {
    /* which sound, an index into the caller's readers */
    int voice;
    /* timeline seconds */
    double start, end;
    /* file seconds under `start` */
    double source_in;
    /* linear; above 1 is a boost, kept as the export keeps it */
    double gain;
    /* linear ramps in seconds, from `start` and to `end` */
    double fade_in, fade_out;
    /* with loop_span above 0, the file's [loop_start, loop_start + loop_span) repeats */
    double loop_start, loop_span;
} MixPiece;

typedef struct Mix {
    const MixPiece *pieces;
    size_t count;
} Mix;

/* Fills `frames` stereo float frames of `voice` from `source_seconds` in its file; frames it
   can't fill stay silent. 0 when the sound can't be read. */
typedef int (*MixRead)(void *opaque, int voice, double source_seconds, float *samples, size_t frames);

/* 1 when the piece is something the mixer can play */
int mix_piece_valid(const MixPiece *piece);
/* the piece's level at timeline second `t`: its gain under its fades */
double mix_piece_level(const MixPiece *piece, double t);
/* the file second under timeline second `t`, inside the piece */
double mix_piece_source(const MixPiece *piece, double t);
/* Sums the mix's `frames` frames from timeline second `start` into `out` (2 floats a frame).
   `scratch` holds at least `frames` frames. 0 when a sound couldn't be read. */
int mix_render(const Mix *mix, double start, size_t frames, MixRead read, void *opaque, float *out,
               float *scratch);

#endif
