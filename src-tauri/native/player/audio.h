/* The video's sound: the preview mix (mix.h) of its own streams and any added files, each read on
   the mix's worker thread (never waiting on anything the picture uses), summed at 48 kHz stereo
   and fed to the sound device. The playback clock says which generation to play from where and
   whether it should be heard; the track follows without ever blocking the caller. */
#ifndef TUCK_AUDIO_H
#define TUCK_AUDIO_H

#include <stddef.h>
#include <stdint.h>

#include "mix.h"

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

/* A track for a file with sound, silent until it is given a mix. NULL when there is nothing to
   hear: with an empty `error` the file has no sound, otherwise the reason its sound can't play. */
AudioTrack *audio_track_open(const char *path, double duration_seconds, char *error, size_t error_size);
/* a track with nothing to mix yet, also for a video without sound that is given some */
AudioTrack *audio_track_new(double duration_seconds, char *error, size_t error_size);
void audio_track_close(AudioTrack *track);
/* the timeline is this long from now on, as edits change it */
void audio_track_set_duration(AudioTrack *track, double duration_seconds);
/* Plays this mix from the next block on; the first one also replaces the silence queued before it.
   `paths` and `streams` name each voice the pieces refer to; the track keeps its own copies. 0
   when out of memory. */
int audio_track_set_mix(AudioTrack *track, const char *const *paths, const int *streams, size_t voice_count,
                        const MixPiece *pieces, size_t piece_count);
/* play `generation` from `seconds` on the timeline at `rate` timeline seconds per second, heard
   while `running`; `seconds` and `rate` only matter when the generation is new */
void audio_track_want(AudioTrack *track, uint64_t generation, double seconds, double rate, int running);
void audio_track_volume(AudioTrack *track, float gain);
/* no sound device has taken the track's stream, as on a PipeWire with no sound devices */
int audio_track_unrouted(AudioTrack *track);
void audio_track_status(AudioTrack *track, AudioTrackStatus *status);

#endif
