/* The sound device: a 48 kHz stereo float stream fed from a bounded PCM queue. Each seek resets
   it to a new generation; the stream stays silent until 100 ms of that generation is queued (or
   the last of it), and `played` counts the seconds of the generation the listener has heard,
   which is what the playback clock follows. */
#ifndef TUCK_AUDIO_OUTPUT_H
#define TUCK_AUDIO_OUTPUT_H

#include <stddef.h>
#include <stdint.h>

typedef struct AudioOutput AudioOutput;

typedef struct AudioOutputStatus {
    uint64_t generation;
    /* seconds of this generation heard so far; never goes back within a generation */
    double played;
    /* times the device wanted sound while the queue was empty during playback */
    uint64_t underruns;
    int failed;
    char error[160];
} AudioOutputStatus;

/* NULL with a reason when no sound device can be used */
AudioOutput *audio_output_open(char *error, size_t error_size);
void audio_output_close(AudioOutput *output);
/* frames taken from `samples` (interleaved stereo); 0 when the queue is full or the generation
   is not the current one */
size_t audio_output_write(AudioOutput *output, const float *samples, size_t frames, uint64_t generation);
/* everything up to the end of `generation` is queued, so it may start with less than 100 ms */
void audio_output_finish(AudioOutput *output, uint64_t generation);
/* drops queued sound and starts `generation`, paused */
void audio_output_reset(AudioOutput *output, uint64_t generation);
/* drops what of `generation` the device hasn't taken yet, keeping what it played and its pause;
   the frames dropped */
size_t audio_output_drop(AudioOutput *output, uint64_t generation);
void audio_output_pause(AudioOutput *output, int paused);
void audio_output_volume(AudioOutput *output, float gain);
/* the device stopped working; status says why */
int audio_output_failed(AudioOutput *output);
/* no device has taken the stream since it opened, so sound written to it is never heard */
int audio_output_unrouted(AudioOutput *output);
void audio_output_status(AudioOutput *output, AudioOutputStatus *status);

#endif
