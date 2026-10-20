/* The timeline's picture: which footage each stretch of the timeline shows. Without segments the
   timeline is the file as it is; with them, each segment shows the file from its source_start and
   the timeline between segments is black. Plain arithmetic, shared with the tests. */
#ifndef TUCK_EDITS_H
#define TUCK_EDITS_H

#include <math.h>
#include <stddef.h>

typedef struct EditSegment {
    /* timeline seconds */
    double start, end;
    /* file second under `start` */
    double source_start;
} EditSegment;

/* what the picture shows at a moment: a segment's footage, the file itself, or nothing */
#define EDITS_GAP (-1)
#define EDITS_WHOLE_FILE (-2)

/* segments in order, apart from each other, inside `duration`, with footage from the file */
static inline int edits_valid(const EditSegment *segments, size_t count, double duration) {
    if (!isfinite(duration) || duration <= 0) return 0;
    double previous_end = 0;
    for (size_t i = 0; i < count; i++) {
        const EditSegment *s = &segments[i];
        if (!isfinite(s->start) || !isfinite(s->end) || !isfinite(s->source_start) || s->source_start < 0 ||
            s->end <= s->start || s->start < previous_end || s->end > duration + 1e-6)
            return 0;
        previous_end = s->end;
    }
    return 1;
}

/* the segment under timeline second `t`, EDITS_GAP between segments, EDITS_WHOLE_FILE without any */
static inline int edits_segment_at(const EditSegment *segments, size_t count, double t) {
    if (!count) return EDITS_WHOLE_FILE;
    for (size_t i = 0; i < count; i++)
        if (t >= segments[i].start && t < segments[i].end) return (int)i;
    return EDITS_GAP;
}

/* the file second under timeline second `t` in segment `index` */
static inline double edits_source(const EditSegment *segments, int index, double t) {
    if (index < 0) return t;
    return segments[index].source_start + t - segments[index].start;
}

#endif
