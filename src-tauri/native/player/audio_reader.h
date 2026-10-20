/* One sound for the mix: a file's Nth audio stream, decoded and resampled to the mix's 48 kHz
   stereo float, read from any position. Reads in order decode on; a read somewhere else seeks.
   Used only from the mix's own thread. */
#ifndef TUCK_AUDIO_READER_H
#define TUCK_AUDIO_READER_H

#include <stddef.h>

typedef struct AudioReader AudioReader;

/* NULL when the file or its stream can't be read; `error` says why */
AudioReader *audio_reader_open(const char *path, int stream, int (*interrupted)(void *), void *opaque,
                               char *error, size_t error_size);
void audio_reader_close(AudioReader *reader);
/* fills `frames` frames from file second `seconds`; past the sound's end they stay silent.
   0 when the sound can't be decoded any more; `error` says why */
int audio_reader_read(AudioReader *reader, double seconds, float *samples, size_t frames, char *error,
                      size_t error_size);

#endif
