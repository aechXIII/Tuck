/* Demuxing and video decoding on a worker thread, with a bounded queue of decoded frames. Every
   seek starts a new generation; frames from older generations are dropped before anyone sees
   them. The platform renderer supplies the hardware device and turns decoder-owned hardware
   frames into frames the queue may keep. */
#ifndef TUCK_DECODER_H
#define TUCK_DECODER_H

#include <stddef.h>
#include <stdint.h>

#include <libavutil/buffer.h>
#include <libavutil/frame.h>
#include <libavutil/hwcontext.h>
#include <libavutil/pixfmt.h>

typedef struct Decoder Decoder;

typedef struct DecoderHooks {
    void *opaque;
    enum AVHWDeviceType device_type;
    enum AVPixelFormat hardware_format;
    /* a new reference to a device the renderer can sample from, or NULL to decode in software */
    AVBufferRef *(*device)(void *opaque);
    /* a frame the queue may hold for long; NULL when the copy failed */
    AVFrame *(*keep)(void *opaque, const AVFrame *frame);
    /* a frame was queued or decoding failed; called without any decoder lock held */
    void (*wake)(void *opaque);
} DecoderHooks;

typedef struct DecodedFrame {
    AVFrame *frame;
    /* seconds on the timeline */
    double time;
    uint64_t generation;
    /* the layout of the frame's pixels; for hardware frames, what the textures hold */
    enum AVPixelFormat sw_format;
    int hardware;
} DecodedFrame;

typedef struct DecoderInfo {
    char name[48];
    char error[160];
    double frame_rate;
    int hardware;
    int failed;
    int ended;
} DecoderInfo;

/* starts the worker; NULL with a reason when the file has no playable video */
Decoder *decoder_open(const char *path, const DecoderHooks *hooks, char *error, size_t error_size);
void decoder_close(Decoder *decoder);
/* frames closer together than this are skipped, so the queue holds what the display can show */
void decoder_set_cadence(Decoder *decoder, double interval);
/* decode from `seconds` as `generation`; the first queued frame is the one showing at that time */
void decoder_seek(Decoder *decoder, double seconds, uint64_t generation);
/* With `first`, the oldest frame of `generation`; otherwise the newest one at or before `time`,
   dropping the frames before it. 0 when there is none yet. The caller owns out->frame. */
int decoder_take(Decoder *decoder, double time, uint64_t generation, int first, DecodedFrame *out);
void decoder_info(Decoder *decoder, DecoderInfo *info);
void decoded_frame_clear(DecodedFrame *frame);

#endif
