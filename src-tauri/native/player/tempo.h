/* Plays 48 kHz stereo float sound faster or slower without changing its pitch, with FFmpeg's
   atempo filter. Normal speed never goes through here. */
#ifndef TUCK_TEMPO_H
#define TUCK_TEMPO_H

#include <stddef.h>

typedef struct Tempo Tempo;

/* NULL when the filter can't start */
Tempo *tempo_open(double rate);
void tempo_close(Tempo *tempo);
/* hands `frames` samples to the filter; NULL `samples` lets out what it still holds, at the end */
int tempo_feed(Tempo *tempo, const float *samples, size_t frames);
/* the next piece of sound at the new speed, or NULL when there is none until more is fed; the
   samples stay valid until the next call */
const float *tempo_take(Tempo *tempo, size_t *frames);

#endif
