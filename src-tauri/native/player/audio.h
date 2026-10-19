/* The video's sound: its own demuxer and decoder on a worker thread (never waiting on anything
   the picture uses), resampled to 48 kHz stereo and fed to the sound device. The playback clock
   says which generation to play from where and whether it should be heard; the track follows
   without ever blocking the caller. */
#ifndef TUCK_AUDIO_H
#define TUCK_AUDIO_H

#include <stddef.h>
#include <stdint.h>

typedef struct AudioTrack AudioTrack;

typedef struct AudioTrackStatus {
    uint64_t generation;
    /* timeline seconds of `generation` heard so far */
    double played;
    uint64_t underruns;
    /* the sound can't play any more; error says why */
    int failed;
    char error[160];
} AudioTrackStatus;

/* NULL when there is nothing to hear: with an empty `error` the file has no sound, otherwise
   the reason its sound can't play */
AudioTrack *audio_track_open(const char *path, double duration_seconds, char *error, size_t error_size);
void audio_track_close(AudioTrack *track);
/* play `generation` from `seconds` on the timeline at `rate` timeline seconds per second, heard
   while `running`; `seconds` and `rate` only matter when the generation is new */
void audio_track_want(AudioTrack *track, uint64_t generation, double seconds, double rate, int running);
void audio_track_volume(AudioTrack *track, float gain);
void audio_track_status(AudioTrack *track, AudioTrackStatus *status);

#endif
