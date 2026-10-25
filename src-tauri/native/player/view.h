/* The editor's crop, turn and flips in the native preview: which part of the decoded picture fills
   the preview and how it is turned onto it. Plain C, so it can be tested without a GPU. */
#ifndef TUCK_VIEW_H
#define TUCK_VIEW_H

#include <math.h>

#include "tuck_video.h"

typedef struct ViewRect {
    float x0, y0, x1, y1;
} ViewRect;

/* what a video shows until the page sends a view: the whole picture, as the file turns it */
#define VIEW_WHOLE ((TuckVideoView){0, 0, 1, 1, 0, 0, 0, 0})

static inline int view_valid(const TuckVideoView *view) {
    /* the page rounds its shares, so they may end a hair past the picture's edge */
    const double slack = 1e-6;
    return view && isfinite(view->x) && isfinite(view->y) && isfinite(view->width) && isfinite(view->height) &&
           view->x >= 0 && view->y >= 0 && view->width > 0 && view->height > 0 &&
           view->x + view->width <= 1 + slack && view->y + view->height <= 1 + slack &&
           view->quarter_turns >= 0 && view->quarter_turns <= 3 &&
           (view->flip_horizontal == 0 || view->flip_horizontal == 1) &&
           (view->flip_vertical == 0 || view->flip_vertical == 1) && (view->stretch == 0 || view->stretch == 1);
}

static inline void view_swap(float *a, float *b) {
    float kept = *a;
    *a = *b;
    *b = kept;
}

/* `picture` is the decoded picture's own rectangle in its planes' pixels and `file_turns` the
   file's rotation onto the screen in right quarter turns, both as libplacebo reads them from the
   frame. Gives the part of the planes the view shows and sets `rotation` to the turn to draw it
   with. A flip comes back as a rectangle with that axis's edges swapped, which libplacebo draws
   mirrored, so the LUT comparison's split still cuts the picture where it is shown. */
static inline ViewRect view_image_crop(ViewRect picture, int file_turns, const TuckVideoView *view,
                                       int *rotation) {
    double u0 = view->x, u1 = view->x + view->width, v0 = view->y, v1 = view->y + view->height;
    double s0, s1, t0, t1;
    switch (((file_turns % 4) + 4) % 4) {
    case 0:
        s0 = u0, s1 = u1, t0 = v0, t1 = v1;
        break;
    case 1:
        /* turned right, the picture's left edge is the planes' bottom */
        s0 = v0, s1 = v1, t0 = 1 - u1, t1 = 1 - u0;
        break;
    case 2:
        s0 = 1 - u1, s1 = 1 - u0, t0 = 1 - v1, t1 = 1 - v0;
        break;
    default:
        /* turned left, the picture's left edge is the planes' top */
        s0 = 1 - v1, s1 = 1 - v0, t0 = u0, t1 = u1;
        break;
    }
    float width = picture.x1 - picture.x0, height = picture.y1 - picture.y0;
    ViewRect crop = {picture.x0 + (float)s0 * width, picture.y0 + (float)t0 * height,
                     picture.x0 + (float)s1 * width, picture.y0 + (float)t1 * height};
    *rotation = file_turns + view->quarter_turns;
    /* the flips mirror the picture as shown, so a sideways turn swaps which plane axis they flip */
    int sideways = ((*rotation % 2) + 2) % 2;
    if (sideways ? view->flip_vertical : view->flip_horizontal) view_swap(&crop.x0, &crop.x1);
    if (sideways ? view->flip_horizontal : view->flip_vertical) view_swap(&crop.y0, &crop.y1);
    return crop;
}

/* the crop's width over its height in plane pixels, whichever way its edges run */
static inline float view_crop_aspect(ViewRect crop) {
    float width = fabsf(crop.x1 - crop.x0), height = fabsf(crop.y1 - crop.y0);
    return height > 0 ? width / height : 0;
}

#endif
