/* The platform side of the player: the GPU device decoding shares, keeping hardware frames
   after the decoder needs its surfaces back, and drawing a decoded frame into the preview. */
#ifndef TUCK_RENDER_H
#define TUCK_RENDER_H

#include <stddef.h>

#include <libplacebo/renderer.h>
#include <libplacebo/shaders/lut.h>

#include "decoder.h"
#include "playback_state.h"
#include "tuck_video.h"

/* the render parameters for drawing with `lut`, or without one when it is NULL */
struct pl_render_params render_params(const struct pl_custom_lut *lut);

#ifdef _WIN32

typedef struct Renderer Renderer;

/* `window` is the preview's child window, which the picture fills */
Renderer *renderer_open(void *window, char *error, size_t error_size);
/* call after the decoder is closed and every frame from it is freed */
void renderer_close(Renderer *renderer);
enum AVHWDeviceType renderer_device_type(void);
enum AVPixelFormat renderer_hardware_format(void);
AVBufferRef *renderer_device(Renderer *renderer);
AVFrame *renderer_keep(Renderer *renderer, const AVFrame *frame);
/* RENDER_SUBMITTED only when the frame was presented; a seek is confirmed by nothing less */
/* `lut` is the preview's colour LUT, or NULL */
RenderOutcome renderer_draw(Renderer *renderer, const DecodedFrame *frame, const struct pl_custom_lut *lut);
/* the preview changed size since the last draw */
int renderer_resized(Renderer *renderer);
/* seconds between display refreshes, so the decoder queues no more frames than can be shown */
double renderer_refresh_interval(Renderer *renderer);
const char *renderer_error(Renderer *renderer);

#else

/* with the GL area's context current, from its render handler */
RenderOutcome gl_renderer_draw(TuckGlRenderer *renderer, const DecodedFrame *frame,
                               const TuckVideoTarget *target, const struct pl_custom_lut *lut);
const char *gl_renderer_error(TuckGlRenderer *renderer);

#endif

#endif
