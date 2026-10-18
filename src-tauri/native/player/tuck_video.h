/* The native player library's exported interface. The desktop shell loads the library at run
   time and checks tuck_video_abi() first, so a missing or mismatched library leaves the editor on
   its HTML player instead of failing to start. Times are seconds on the editor's timeline. */
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
#define TUCK_VIDEO_ABI 1

typedef struct TuckVideo TuckVideo;

typedef struct TuckVideoOpen {
    /* UTF-8 */
    const char *path;
    /* the editor's length for this video; playback stops there */
    double duration_seconds;
    /* Windows: the child window the picture fills */
    void *window;
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
TUCK_VIDEO_EXPORT void tuck_video_status(TuckVideo *video, TuckVideoStatus *status);

#endif
