/* Comparing the LUT in the preview: the picture as it is on the left of a split, with the LUT on
   the right. The drawing passes it as a second render into the right part only, so this works out
   which part of the target that is and which part of the image lands there. Plain C, so it can be
   tested without a GPU. */
#ifndef TUCK_LUT_SPLIT_H
#define TUCK_LUT_SPLIT_H

typedef struct SplitRect {
    float x0, y0, x1, y1;
} SplitRect;

/* `split` runs from 0 to 1 across the picture as shown; `rotation` is the image's clockwise turn
   onto the target in quarter turns, as libplacebo's pl_rotation counts it. The image is cut along
   whichever of its axes the turn lays across the screen, so both parts meet without a seam. */
static inline void lut_split_right(SplitRect target, SplitRect image, int rotation, double split,
                                   SplitRect *target_part, SplitRect *image_part) {
    float share = (float)split;
    *target_part = target;
    target_part->x0 = target.x0 + share * (target.x1 - target.x0);
    *image_part = image;
    switch (((rotation % 4) + 4) % 4) {
    case 0:
        image_part->x0 = image.x0 + share * (image.x1 - image.x0);
        break;
    case 1:
        /* turned right, the image's top edge is the picture's right edge */
        image_part->y1 = image.y0 + (1 - share) * (image.y1 - image.y0);
        break;
    case 2:
        image_part->x1 = image.x0 + (1 - share) * (image.x1 - image.x0);
        break;
    default:
        image_part->y0 = image.y0 + share * (image.y1 - image.y0);
        break;
    }
}

#endif
