/* The preview's colour LUT. The editor sends the table the backend loaded and checked; the drawing
   thread blends it by strength (lut_blend.h) and libplacebo applies it to the non-linear RGB values
   (PL_LUT_NATIVE), as the export's lut3d filter does. Any thread may change it. */
#ifndef TUCK_LUT_H
#define TUCK_LUT_H

#include <pthread.h>
#include <stdint.h>

#include <libplacebo/shaders/lut.h>

/* the sizes the backend accepts from a .cube file */
#define LUT_MIN_SIZE 2
#define LUT_MAX_SIZE 65

typedef struct PreviewLut {
    pthread_mutex_t lock;
    /* under lock: what the editor sent */
    float *table;
    int size;
    double strength;
    uint64_t changes;
    /* the drawing thread's */
    uint64_t applied;
    float *blended;
    struct pl_custom_lut lut;
} PreviewLut;

void preview_lut_init(PreviewLut *lut);
void preview_lut_destroy(PreviewLut *lut);
/* copies `size`³ RGB samples; NULL clears. 0 when the size is outside what the backend accepts */
int preview_lut_set_table(PreviewLut *lut, const float *table, int size);
void preview_lut_set_strength(PreviewLut *lut, double strength);
/* the drawing thread's LUT for the next frame, or NULL for none; valid until the next call */
const struct pl_custom_lut *preview_lut_current(PreviewLut *lut);

#endif
