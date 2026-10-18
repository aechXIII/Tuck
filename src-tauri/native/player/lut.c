#include "lut.h"

#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "lut_blend.h"
#include "render.h"

/* libplacebo keeps an uploaded LUT until its signature changes, and the Linux renderer outlives
   each video, so signatures never repeat within the app */
static atomic_uint_fast64_t signatures;

void preview_lut_init(PreviewLut *lut) {
    memset(lut, 0, sizeof(*lut));
    pthread_mutex_init(&lut->lock, NULL);
    lut->strength = 1;
}

void preview_lut_destroy(PreviewLut *lut) {
    free(lut->table);
    free(lut->blended);
    pthread_mutex_destroy(&lut->lock);
}

int preview_lut_set_table(PreviewLut *lut, const float *table, int size) {
    float *copy = NULL;
    if (table) {
        if (size < LUT_MIN_SIZE || size > LUT_MAX_SIZE) return 0;
        size_t bytes = (size_t)size * size * size * 3 * sizeof(float);
        copy = malloc(bytes);
        if (!copy) return 0;
        memcpy(copy, table, bytes);
    }
    pthread_mutex_lock(&lut->lock);
    free(lut->table);
    lut->table = copy;
    lut->size = copy ? size : 0;
    lut->changes++;
    pthread_mutex_unlock(&lut->lock);
    return 1;
}

void preview_lut_set_strength(PreviewLut *lut, double strength) {
    if (!isfinite(strength)) return;
    pthread_mutex_lock(&lut->lock);
    lut->strength = fmin(1, fmax(0, strength));
    lut->changes++;
    pthread_mutex_unlock(&lut->lock);
}

struct pl_render_params render_params(const struct pl_custom_lut *lut) {
    struct pl_render_params params = pl_render_default_params;
    if (lut) {
        params.lut = lut;
        /* on the non-linear RGB values, where the export's lut3d filter applies it too */
        params.lut_type = PL_LUT_NATIVE;
    }
    return params;
}

const struct pl_custom_lut *preview_lut_current(PreviewLut *lut) {
    pthread_mutex_lock(&lut->lock);
    if (lut->changes != lut->applied) {
        lut->applied = lut->changes;
        free(lut->blended);
        lut->blended = NULL;
        if (lut->table && lut->strength > 0) {
            size_t samples = (size_t)lut->size * lut->size * lut->size * 3;
            lut->blended = malloc(samples * sizeof(float));
            if (lut->blended) lut_blend(lut->blended, lut->table, lut->size, lut->strength);
        }
        memset(&lut->lut, 0, sizeof(lut->lut));
        if (lut->blended) {
            lut->lut.signature = atomic_fetch_add(&signatures, 1) + 1;
            lut->lut.size[0] = lut->lut.size[1] = lut->lut.size[2] = lut->size;
            lut->lut.data = lut->blended;
        }
    }
    const struct pl_custom_lut *current = lut->blended ? &lut->lut : NULL;
    pthread_mutex_unlock(&lut->lock);
    return current;
}
