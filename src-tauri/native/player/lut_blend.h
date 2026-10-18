/* The preview's LUT at a strength: the table blended with an identity table, the same mix the
   export bakes into its LUT (tuck/lut.py) and the HTML player's preview shader makes. Tables are
   RGB floats with R changing fastest, then G, then B. */
#ifndef TUCK_LUT_BLEND_H
#define TUCK_LUT_BLEND_H

#include <stddef.h>

static inline void lut_blend(float *out, const float *table, int size, double strength) {
    size_t i = 0;
    for (int b = 0; b < size; b++)
        for (int g = 0; g < size; g++)
            for (int r = 0; r < size; r++, i += 3) {
                const double identity[3] = {(double)r / (size - 1), (double)g / (size - 1), (double)b / (size - 1)};
                for (int c = 0; c < 3; c++)
                    out[i + c] = (float)(identity[c] * (1 - strength) + table[i + c] * strength);
            }
}

#endif
