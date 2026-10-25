/* The native player library's exported interface. The desktop shell loads the library at run
   time and checks tuck_video_abi() first, so a missing or mismatched library leaves the editor on
   its HTML player instead of failing to start. Times are seconds on the editor's timeline.

   Windows: the library draws from its own thread into the child window given at open.
   Linux: GTK draws on its main thread, so the shell owns a GL area, creates a TuckGlRenderer while
   the area's context is current, asks tuck_video_due() on each frame clock tick and calls
   tuck_video_draw() from the area's render handler. */
#ifndef TUCK_VIDEO_H
#define TUCK_VIDEO_H

#include <stddef.h>
#include <stdint.h>

#include "engine.h"

#if defined(_WIN32) && defined(TUCK_VIDEO_BUILD)
#define TUCK_VIDEO_EXPORT __declspec(dllexport)
#elif defined(TUCK_VIDEO_BUILD)
#define TUCK_VIDEO_EXPORT __attribute__((visibility("default")))
#else
#define TUCK_VIDEO_EXPORT
#endif

/* raise whenever a signature or struct below changes */
#define TUCK_VIDEO_ABI 10

/* TuckVideoStatus.sound */
#define TUCK_SOUND_NONE 0
/* the sound plays and the clock follows what the listener has heard */
#define TUCK_SOUND_PLAYING 1
/* the file has sound that can't play (sound_error says why); the clock runs on monotonic time */
#define TUCK_SOUND_UNAVAILABLE 2

/* TuckVideoStatus.software_reason: why the frames come from software decoding */
#define TUCK_SOFTWARE_NONE 0
/* no GPU decoding device could be opened, such as a missing or refusing driver */
#define TUCK_SOFTWARE_NO_DEVICE 1
/* the GPU decoders don't handle this codec */
#define TUCK_SOFTWARE_CODEC 2
/* the GPU decoder for this codec could not start */
#define TUCK_SOFTWARE_START_FAILED 3
/* the GPU can't decode this particular stream, such as its profile or pixel format */
#define TUCK_SOFTWARE_STREAM 4

typedef struct TuckVideo TuckVideo;

typedef struct TuckVideoOpen {
    /* UTF-8 */
    const char *path;
    /* the editor's length for this video; playback stops there */
    double duration_seconds;
    /* Windows: the child window the picture fills. Linux: unused */
    void *window;
    /* seconds between display refreshes when the shell knows them; 0 lets the library decide */
    double display_interval;
    /* Linux: 1 when the renderer can't import GPU frames, so the decoder copies each frame it
       keeps to memory on its own thread instead of the draw doing it on GTK's */
    int32_t download_frames;
} TuckVideoOpen;

typedef struct TuckVideoStatus {
    TuckPlayerStatus clock;
    double frame_rate;
    uint64_t presented;
    /* 1 while frames come from hardware decoding */
    int32_t hardware;
    /* the video can't play any more; error says why */
    int32_t failed;
    char decoder[48];
    char error[192];
    /* times the device wanted sound before it was decoded */
    uint64_t sound_underruns;
    int32_t sound;
    char sound_error[160];
    /* TUCK_SOFTWARE_*; NONE while frames come, or are expected to come, from the GPU */
    int32_t software_reason;
} TuckVideoStatus;

TUCK_VIDEO_EXPORT int tuck_video_abi(void);
/* NULL with a reason in error when the file can't be opened or nothing can draw it */
TUCK_VIDEO_EXPORT TuckVideo *tuck_video_open(const TuckVideoOpen *open, char *error,
                                             size_t error_size);
TUCK_VIDEO_EXPORT void tuck_video_close(TuckVideo *video);
TUCK_VIDEO_EXPORT void tuck_video_play(TuckVideo *video);
TUCK_VIDEO_EXPORT void tuck_video_pause(TuckVideo *video);
/* 0 when the request ID is not newer than the last one or the position is outside the video */
TUCK_VIDEO_EXPORT int tuck_video_seek(TuckVideo *video, uint64_t request_id, double seconds);
/* Plays `rate` timeline seconds per second, with the sound's pitch kept; a new speed restarts
   sound and picture at the same spot. 0 when the speed is outside 0.25 to 4. */
TUCK_VIDEO_EXPORT int tuck_video_rate(TuckVideo *video, double rate);

/* a stretch of the timeline that shows the file's footage from `source_start` */
typedef struct TuckEditSegment {
    double start;
    double end;
    double source_start;
} TuckEditSegment;

/* The timeline: `duration` seconds long, showing each segment's footage and black between them;
   no segments shows the file as it is. Segments go in order without overlapping. 0 when they
   don't, or there are more than 65536. */
TUCK_VIDEO_EXPORT int tuck_video_edits(TuckVideo *video, const TuckEditSegment *segments, int32_t count,
                                       double duration);

/* one sound of the preview mix: a file and which of its sound streams, counted from 0 */
typedef struct TuckMixVoice {
    /* UTF-8 */
    const char *path;
    int32_t stream;
} TuckMixVoice;

/* a stretch of one voice on the timeline: file second `source_in` plays at `start`, at linear
   `gain` under linear fades; with `loop_span` the file's [loop_start, loop_start + loop_span)
   repeats */
typedef struct TuckMixPiece {
    int32_t voice;
    double start;
    double end;
    double source_in;
    double gain;
    double fade_in;
    double fade_out;
    double loop_start;
    double loop_span;
} TuckMixPiece;

/* Plays this mix instead of the video's own sound from the next moment on; a video without sound
   starts its clock on the mix. The library keeps its own copies. 0 when a voice or piece is
   unusable or there are more than 256 voices or 65536 pieces. */
TUCK_VIDEO_EXPORT int tuck_video_mix(TuckVideo *video, const TuckMixVoice *voices, int32_t voice_count,
                                     const TuckMixPiece *pieces, int32_t piece_count);
/* the sound's level, 0 to 1 */
TUCK_VIDEO_EXPORT void tuck_video_volume(TuckVideo *video, double gain);
/* The preview's colour LUT: `size`³ RGB samples from 0 to 1 with R changing fastest, as the
   backend loads a .cube file; NULL removes it. 0 when the size is outside 2 to 65. */
TUCK_VIDEO_EXPORT int tuck_video_lut_table(TuckVideo *video, const float *table, int32_t size);
/* how much of the LUT shows, 0 to 1; 0 shows the picture as it is */
TUCK_VIDEO_EXPORT void tuck_video_lut_strength(TuckVideo *video, double strength);
/* Compares the LUT: from 0 to 1 across the picture as shown, the picture as it is left of `split`
   and with the LUT right of it. A negative value shows the LUT everywhere again. */
TUCK_VIDEO_EXPORT void tuck_video_lut_split(TuckVideo *video, double split);

/* The editor's crop, turn and flips: which part of the picture fills the preview and how it is
   turned onto it. The part is in shares of the picture's width and height as the file's own
   rotation shows it, the picture the editor crops; 0, 0, 1, 1 is all of it. */
typedef struct TuckVideoView {
    double x, y, width, height;
    /* quarter turns to the right on top of the file's own rotation, 0 to 3 */
    int32_t quarter_turns;
    /* 1 mirrors the picture as shown, after the turn */
    int32_t flip_horizontal;
    int32_t flip_vertical;
    /* 1 fills the preview even where that changes the picture's shape, as the Stretch sizing
       does; 0 keeps the shape and leaves bars */
    int32_t stretch;
} TuckVideoView;

/* Shows `view` from the next frame on, also while paused. 0 when a share is outside the picture,
   the turn outside 0 to 3 or a switch not 0 or 1. */
TUCK_VIDEO_EXPORT int tuck_video_view(TuckVideo *video, const TuckVideoView *view);
TUCK_VIDEO_EXPORT void tuck_video_status(TuckVideo *video, TuckVideoStatus *status);

#ifndef _WIN32
typedef struct TuckGlRenderer TuckGlRenderer;

/* where to draw: the GL area's size and the picture inside it, in device pixels from the top left */
typedef struct TuckVideoTarget {
    int32_t width, height;
    int32_t picture_x, picture_y, picture_width, picture_height;
} TuckVideoTarget;

/* with the GL area's context current; NULL with a reason when GL can't be used */
TUCK_VIDEO_EXPORT TuckGlRenderer *tuck_gl_renderer_create(char *error, size_t error_size);
/* with the same context current */
TUCK_VIDEO_EXPORT void tuck_gl_renderer_destroy(TuckGlRenderer *renderer);
/* whether the context can take VAAPI frames without a copy: EGL can, GLX (X11) can't */
TUCK_VIDEO_EXPORT int tuck_gl_renderer_imports_frames(TuckGlRenderer *renderer);
/* `shown_at` is when the drawn frame reaches the screen, in CLOCK_MONOTONIC seconds as GTK's frame
   clock gives it, so every refresh picks its frame for the same moment; 0 picks it for now */
/* whether drawing would show a different frame than the last draw */
TUCK_VIDEO_EXPORT int tuck_video_due(TuckVideo *video, double shown_at);
/* draws the frame for the clock into the bound framebuffer; 0 when nothing could be drawn */
TUCK_VIDEO_EXPORT int tuck_video_draw(TuckVideo *video, TuckGlRenderer *renderer,
                                      const TuckVideoTarget *target, double shown_at);
/* clears the bound framebuffer while no video is open */
TUCK_VIDEO_EXPORT void tuck_gl_renderer_clear(TuckGlRenderer *renderer, const TuckVideoTarget *target);
#endif

#endif
