/* GTK gives the GL area's framebuffer by ID each frame. Wrapping it for libplacebo every frame
   leaked libplacebo's per-texture data (2.7 MiB a minute in the prototype), so the wrapper is
   kept until the ID or the size changes. */
#ifndef TUCK_FRAMEBUFFER_CACHE_H
#define TUCK_FRAMEBUFFER_CACHE_H

#include <stdint.h>

typedef struct FramebufferCacheState {
    unsigned framebuffer;
    int width, height, valid;
    uint64_t wraps;
} FramebufferCacheState;

static inline int framebuffer_cache_matches(const FramebufferCacheState *state, unsigned framebuffer,
                                            int width, int height) {
    return state->valid && state->framebuffer == framebuffer && state->width == width &&
           state->height == height;
}

static inline void framebuffer_cache_created(FramebufferCacheState *state, unsigned framebuffer,
                                             int width, int height) {
    state->framebuffer = framebuffer;
    state->width = width;
    state->height = height;
    state->valid = 1;
    state->wraps++;
}

static inline void framebuffer_cache_reset(FramebufferCacheState *state) {
    state->framebuffer = 0;
    state->width = state->height = state->valid = 0;
}

#endif
