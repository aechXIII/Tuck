/* Seeks carry increasing request IDs from the page. A seek is confirmed only for the request whose
   new-generation frame was actually shown, so an older confirmation can never clear a newer seek. */
#ifndef TUCK_SEEK_REQUEST_H
#define TUCK_SEEK_REQUEST_H

#include <stdint.h>

/* the largest integer JavaScript numbers hold exactly */
#define SEEK_REQUEST_MAX 9007199254740991ULL

typedef struct SeekRequest {
    uint64_t requested, confirmed, generation;
} SeekRequest;

static inline int seek_request_accept(SeekRequest *state, uint64_t id, uint64_t generation) {
    if (!id || id > SEEK_REQUEST_MAX || id <= state->requested || generation <= state->generation) return 0;
    state->requested = id;
    state->generation = generation;
    return 1;
}

/* a restart before the seek's frame was shown (a new speed, a shorter timeline, sound added)
   moves the seek to the new generation, whose first frame then confirms it */
static inline void seek_request_follow(SeekRequest *state, uint64_t generation) {
    if (state->requested != state->confirmed) state->generation = generation;
}

static inline int seek_request_confirm(SeekRequest *state, uint64_t generation) {
    if (!state->requested || generation != state->generation) return 0;
    state->confirmed = state->requested;
    return 1;
}

#endif
