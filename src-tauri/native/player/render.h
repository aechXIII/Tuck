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
#include "view.h"

/* the render parameters for drawing with `lut`, or without one when it is NULL */
struct pl_render_params render_params(const struct pl_custom_lut *lut);

/* Puts the view's part of `image` into `area`: the image's crop and rotation come from the view, and
   unless the view stretches, `area` shrinks to the part's shape (with the frame's pixel shape) and
   leaves bars around it, as the whole picture always did. */
static inline void render_place_view(struct pl_frame *image, pl_rect2df *area, pl_rotation area_rotation,
                                     AVRational sar, const TuckVideoView *view) {
    int rotation;
    ViewRect crop = view_image_crop((ViewRect){image->crop.x0, image->crop.y0, image->crop.x1, image->crop.y1},
                                    image->rotation, view, &rotation);
    image->crop = (pl_rect2df){crop.x0, crop.y0, crop.x1, crop.y1};
    image->rotation = rotation;
    if (view->stretch) return;
    float aspect = view_crop_aspect(crop);
    if (sar.num > 0 && sar.den > 0) aspect *= (float)av_q2d(sar);
    pl_rect2df_aspect_set_rot(area, aspect, image->rotation - area_rotation, 0);
}

/* Draws `image` into `target` with `lut`, or, with a split from 0 to 1, without it and then with it
   over the part right of the split only. 0 when libplacebo could not draw. */
int render_with_lut(pl_renderer renderer, const struct pl_frame *image, const struct pl_frame *target,
                    const struct pl_custom_lut *lut, double split);

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
/* `lut` is the preview's colour LUT, or NULL; with a `split` from 0 to 1 it shows only right of
   that share of the picture (preview_lut_split). `view` is the part shown and its turn (view.h). */
RenderOutcome renderer_draw(Renderer *renderer, const DecodedFrame *frame, const struct pl_custom_lut *lut,
                            double split, const TuckVideoView *view);
/* black across the preview, for a timeline gap; RENDER_SUBMITTED only when presented */
RenderOutcome renderer_clear(Renderer *renderer);
/* the preview changed size since the last draw */
int renderer_resized(Renderer *renderer);
/* seconds between display refreshes, so the decoder queues no more frames than can be shown */
double renderer_refresh_interval(Renderer *renderer);
const char *renderer_error(Renderer *renderer);

#else

/* with the GL area's context current, from its render handler; `lut`, `split` and `view` as above */
RenderOutcome gl_renderer_draw(TuckGlRenderer *renderer, const DecodedFrame *frame,
                               const TuckVideoTarget *target, const struct pl_custom_lut *lut, double split,
                               const TuckVideoView *view);
const char *gl_renderer_error(TuckGlRenderer *renderer);

#endif

#endif
