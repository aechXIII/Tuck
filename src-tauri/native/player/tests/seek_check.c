/* Exact seeks and frame steps through the player's own decoder, without a display. For every clip
   in a seek-fixtures.txt from scripts/player_fixtures.py it seeks to frame times, to times between
   frames and back and forth across the clip, then steps forward frame by frame, and checks each
   time that the frame the player would show is the one the file shows at that time. Decoding is
   in software, so it runs anywhere; the hardware paths are checked in the app. For every sound in
   the list it checks that the mix's reader gives the same sound wherever it was before a read.

   Usage: tuck_player_seek_check <seek-fixtures.txt> [clip ...] */
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../audio_reader.h"
#include "../decoder.h"
#include "../mix.h"

/* a frame time from the list and the decoder's own agree to well within this */
#define SAME_TIME 1e-6
/* one seek or step that takes longer than this has hung */
#define TAKE_TIMEOUT_SECONDS 60.0
#define STEPS 30
/* the sound check reads this stretch, twice; the first frame decoded after a seek depends on where
   the decoder was, so the two are compared after it */
#define SOUND_AT 2.0
#define SOUND_FRAMES 8192
#define SOUND_SETTLED 2048
#define SOUND_BLOCK 1024

typedef struct Waiter {
    pthread_mutex_t lock;
    pthread_cond_t woken;
} Waiter;

typedef struct Clip {
    char name[256];
    double *times;
    size_t count;
} Clip;

static void wake(void *opaque) {
    Waiter *w = opaque;
    pthread_mutex_lock(&w->lock);
    pthread_cond_broadcast(&w->woken);
    pthread_mutex_unlock(&w->lock);
}

static double seconds_now(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (double)now.tv_sec + now.tv_nsec / 1e9;
}

/* the frame showing at `time`: the newest at or before it, or the first when the clip starts later */
static size_t showing_at(const Clip *clip, double time) {
    size_t found = 0;
    for (size_t i = 0; i < clip->count && clip->times[i] <= time + SAME_TIME; i++) found = i;
    return found;
}

/* waits for the decoder's frame; 0 on failure, with the reason printed */
static int take(Decoder *d, Waiter *w, const Clip *clip, double time, uint64_t generation, int first,
                DecodedFrame *out) {
    double deadline = seconds_now() + TAKE_TIMEOUT_SECONDS;
    while (!decoder_take(d, time, generation, first, out)) {
        DecoderInfo info;
        decoder_info(d, &info);
        if (info.failed) {
            printf("FAIL %s: %s\n", clip->name, info.error);
            return 0;
        }
        if (seconds_now() > deadline) {
            printf("FAIL %s: no frame for %.6f s after %.0f s\n", clip->name, time, TAKE_TIMEOUT_SECONDS);
            return 0;
        }
        struct timespec until;
        clock_gettime(CLOCK_REALTIME, &until);
        until.tv_nsec += 50000000;
        until.tv_sec += until.tv_nsec / 1000000000;
        until.tv_nsec %= 1000000000;
        pthread_mutex_lock(&w->lock);
        pthread_cond_timedwait(&w->woken, &w->lock, &until);
        pthread_mutex_unlock(&w->lock);
    }
    return 1;
}

static int same_frame(const Clip *clip, const DecodedFrame *frame, size_t expected, double target, const char *what) {
    if (fabs(frame->time - clip->times[expected]) < SAME_TIME) return 1;
    printf("FAIL %s: %s %.6f showed the frame at %.6f, not frame %lu at %.6f\n", clip->name, what, target,
           frame->time, (unsigned long)expected, clip->times[expected]);
    return 0;
}

static size_t add(double *targets, size_t used, double time) {
    targets[used] = time;
    return used + 1;
}

/* the first and last frames, frame times and the moments between frames spread over the clip,
   and jumps back and forth across it */
static size_t choose_targets(const Clip *clip, double *targets) {
    size_t used = 0, n = clip->count;
    if (clip->times[0] > 0) used = add(targets, used, 0);
    for (size_t i = 0; i < 3 && i < n; i++) used = add(targets, used, clip->times[i]);
    for (size_t i = n > 3 ? n - 3 : 0; i < n; i++) used = add(targets, used, clip->times[i]);
    size_t spread = n > 600 ? 8 : 20;
    for (size_t k = 1; k <= spread; k++) {
        size_t i = k * (n - 1) / (spread + 1);
        used = add(targets, used, clip->times[i]);
        used = add(targets, used, (clip->times[i] + clip->times[i + 1]) / 2);
    }
    uint32_t state = 12345;
    for (size_t k = 0; k < (n > 600 ? 6 : 12); k++) {
        state = state * 1103515245u + 12345u;
        used = add(targets, used, clip->times[(state >> 8) % n]);
    }
    return used;
}

static int check_clip(const char *folder, const Clip *clip, double *slowest) {
    char path[1024 + 256 + 2];
    snprintf(path, sizeof(path), "%s/%s", folder, clip->name);
    Waiter w;
    pthread_mutex_init(&w.lock, NULL);
    pthread_cond_init(&w.woken, NULL);
    DecoderHooks hooks = {
        .opaque = &w,
        .device_type = AV_HWDEVICE_TYPE_NONE,
        .hardware_format = AV_PIX_FMT_NONE,
        .wake = wake,
    };
    char error[256] = {0};
    Decoder *d = decoder_open(path, &hooks, error, sizeof(error));
    if (!d) {
        printf("FAIL %s: %s\n", clip->name, error);
        return 1;
    }
    /* every frame, as at a display rate faster than the clip */
    decoder_set_cadence(d, 0);
    int failures = 0;
    uint64_t generation = 0;
    double targets[64];
    size_t seeks = choose_targets(clip, targets);
    for (size_t i = 0; i < seeks && failures < 5; i++) {
        DecodedFrame frame = {0};
        double started = seconds_now();
        decoder_seek(d, targets[i], ++generation);
        if (!take(d, &w, clip, targets[i], generation, 1, &frame)) {
            failures++;
            continue;
        }
        double took = seconds_now() - started;
        if (took > *slowest) *slowest = took;
        if (!same_frame(clip, &frame, showing_at(clip, targets[i]), targets[i], "a seek to")) failures++;
        decoded_frame_clear(&frame);
    }
    /* frame steps forward, as playback and the step key move */
    size_t starts[] = {0, clip->count / 3, clip->count > STEPS + 1 ? clip->count - STEPS - 1 : 0};
    size_t steps = 0;
    for (size_t s = 0; s < 3 && failures < 5; s++) {
        size_t at = starts[s];
        DecodedFrame frame = {0};
        decoder_seek(d, clip->times[at], ++generation);
        if (!take(d, &w, clip, clip->times[at], generation, 1, &frame)) {
            failures++;
            continue;
        }
        decoded_frame_clear(&frame);
        for (size_t k = at + 1; k <= at + STEPS && k < clip->count && failures < 5; k++, steps++) {
            /* asked a hair late, as the player asks with a little slack: listed times are rounded */
            if (!take(d, &w, clip, clip->times[k] + SAME_TIME, generation, 0, &frame)) {
                failures++;
                break;
            }
            if (!same_frame(clip, &frame, k, clip->times[k], "a step to")) failures++;
            decoded_frame_clear(&frame);
        }
    }
    DecoderInfo info;
    decoder_info(d, &info);
    decoder_close(d);
    pthread_cond_destroy(&w.woken);
    pthread_mutex_destroy(&w.lock);
    if (!failures)
        printf("ok   %s (%s): %lu seeks and %lu steps exact, slowest seek %.0f ms\n", clip->name, info.name,
               (unsigned long)seeks, (unsigned long)steps, *slowest * 1000);
    return failures;
}

/* A stretch read after the reader has gone past it must be the same sound a fresh reader gives
   there. Blocks that don't line up with the decoder's frames leave part of one buffered, which
   once came back as silence until the read caught up with it. */
static int check_sound(const char *folder, const char *name) {
    char path[1024 + 256 + 2];
    snprintf(path, sizeof(path), "%s/%s", folder, name);
    static float expected[SOUND_FRAMES * 2], got[SOUND_FRAMES * 2], block[SOUND_BLOCK * 2];
    char error[256] = {0};
    AudioReader *fresh = audio_reader_open(path, 0, NULL, NULL, error, sizeof(error));
    AudioReader *ahead = fresh ? audio_reader_open(path, 0, NULL, NULL, error, sizeof(error)) : NULL;
    int ok = ahead && audio_reader_read(fresh, SOUND_AT, expected, SOUND_FRAMES, error, sizeof(error));
    for (double t = 0.0137; ok && t < SOUND_AT + 0.5; t += (double)SOUND_BLOCK / MIX_RATE)
        ok = audio_reader_read(ahead, t, block, SOUND_BLOCK, error, sizeof(error));
    ok = ok && audio_reader_read(ahead, SOUND_AT, got, SOUND_FRAMES, error, sizeof(error));
    audio_reader_close(fresh);
    audio_reader_close(ahead);
    if (!ok) {
        printf("FAIL %s: %s\n", name, error);
        return 1;
    }
    double loudest = 0, worst = 0;
    for (size_t i = SOUND_SETTLED * 2; i < SOUND_FRAMES * 2; i++) {
        loudest = fmax(loudest, fabs(expected[i]));
        worst = fmax(worst, fabs(got[i] - expected[i]));
    }
    if (loudest < 0.01) {
        printf("FAIL %s: a fresh read at %.1f s is silent\n", name, SOUND_AT);
        return 1;
    }
    if (worst > 1e-6) {
        printf("FAIL %s: reading %.1f s again after reading past it is off by up to %g\n", name, SOUND_AT, worst);
        return 1;
    }
    printf("ok   %s: the sound reads the same after reading past it\n", name);
    return 0;
}

static int wanted(const char *name, int argc, char **argv) {
    if (argc <= 2) return 1;
    for (int i = 2; i < argc; i++)
        if (!strcmp(argv[i], name)) return 1;
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <seek-fixtures.txt> [clip ...]\n", argv[0]);
        return 2;
    }
    FILE *list = fopen(argv[1], "r");
    if (!list) {
        fprintf(stderr, "Can't read %s\n", argv[1]);
        return 2;
    }
    /* the clips sit next to the list */
    char folder[1024];
    snprintf(folder, sizeof(folder), "%s", argv[1]);
    char *slash = strrchr(folder, '/');
    char *backslash = strrchr(folder, '\\');
    if (backslash > slash) slash = backslash;
    if (slash)
        *slash = 0;
    else
        snprintf(folder, sizeof(folder), ".");
    int failures = 0, clips = 0, sounds = 0;
    Clip clip;
    char word[16];
    unsigned long count;
    while (fscanf(list, "%15s %255s %lu", word, clip.name, &count) == 3) {
        if (!strcmp(word, "sound") && !count) {
            if (wanted(clip.name, argc, argv)) {
                failures += check_sound(folder, clip.name);
                sounds++;
            }
            continue;
        }
        clip.count = count;
        if (strcmp(word, "clip") || !clip.count) {
            fprintf(stderr, "%s is not a seek-fixtures list\n", argv[1]);
            return 2;
        }
        clip.times = malloc(clip.count * sizeof(double));
        if (!clip.times) return 2;
        for (size_t i = 0; i < clip.count; i++)
            if (fscanf(list, "%lf", &clip.times[i]) != 1) {
                fprintf(stderr, "%s lists too few frame times for %s\n", argv[1], clip.name);
                return 2;
            }
        if (wanted(clip.name, argc, argv)) {
            double slowest = 0;
            failures += check_clip(folder, &clip, &slowest);
            clips++;
        }
        free(clip.times);
    }
    fclose(list);
    printf("%s: %d clips, %d sounds, %d failures\n", failures ? "FAILED" : "all exact", clips, sounds, failures);
    return failures ? 1 : 0;
}
