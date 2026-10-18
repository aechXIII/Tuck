#include "decoder.h"

#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/pixdesc.h>

#include "playback_state.h"

#define QUEUE_LIMIT 40
/* damaged packets in a row before the video counts as undecodable */
#define BAD_PACKET_LIMIT 100

struct Decoder {
    DecoderHooks hooks;
    AVFormatContext *format;
    AVCodecContext *codec;
    int stream;
    AVRational time_base;
    /* the container's start, so the first frame lands near zero like in the HTML player */
    double start;
    double frame_rate;
    int hardware_codec;
    int bad_packets;

    pthread_t thread;
    int thread_started;
    pthread_mutex_t lock;
    /* a new request, room in the queue, or closing */
    pthread_cond_t changed;
    atomic_int closing;

    /* the player's request, written under lock; the worker checks it while decoding */
    _Atomic uint64_t requested_generation;
    double requested_time;
    double cadence;

    /* under lock */
    DecodedFrame queue[QUEUE_LIMIT];
    unsigned head, count, capacity;
    char codec_name[32];
    char error[160];
    /* frames_seen tells whether hardware_frames says anything yet */
    int failed, ended, frames_seen, hardware_frames;

    /* worker only */
    uint64_t generation;
    double target;
    double next;
    /* the newest frame at or before the target, queued once a later frame shows it is the one */
    DecodedFrame candidate;
    int started;
};

void decoded_frame_clear(DecodedFrame *frame) {
    av_frame_free(&frame->frame);
    memset(frame, 0, sizeof(*frame));
}

static void fail(Decoder *d, const char *message) {
    pthread_mutex_lock(&d->lock);
    if (!d->failed) snprintf(d->error, sizeof(d->error), "%s", message);
    d->failed = 1;
    pthread_cond_broadcast(&d->changed);
    pthread_mutex_unlock(&d->lock);
    if (d->hooks.wake) d->hooks.wake(d->hooks.opaque);
}

static int interrupted(void *opaque) {
    return atomic_load(&((Decoder *)opaque)->closing);
}

static int superseded(Decoder *d, uint64_t generation) {
    return atomic_load(&d->closing) || generation != atomic_load(&d->requested_generation);
}

static enum AVPixelFormat choose_format(AVCodecContext *codec, const enum AVPixelFormat *formats) {
    Decoder *d = codec->opaque;
    for (const enum AVPixelFormat *f = formats; *f != AV_PIX_FMT_NONE; f++)
        if (*f == d->hooks.hardware_format) return *f;
    /* the GPU can't decode this stream; take the decoder's own format instead */
    for (const enum AVPixelFormat *f = formats; *f != AV_PIX_FMT_NONE; f++) {
        const AVPixFmtDescriptor *desc = av_pix_fmt_desc_get(*f);
        if (desc && !(desc->flags & AV_PIX_FMT_FLAG_HWACCEL)) return *f;
    }
    return AV_PIX_FMT_NONE;
}

static int hardware_capable(const AVCodec *codec, enum AVHWDeviceType type) {
    for (int i = 0;; i++) {
        const AVCodecHWConfig *config = avcodec_get_hw_config(codec, i);
        if (!config) return 0;
        if (config->device_type == type && (config->methods & AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX))
            return 1;
    }
}

/* FFmpeg's own AV1 decoder only works with a hardware device; dav1d decodes AV1 in software */
static const AVCodec *find_decoder(enum AVCodecID id, int hardware) {
    if (id == AV_CODEC_ID_AV1) {
        const AVCodec *codec = avcodec_find_decoder_by_name(hardware ? "av1" : "libdav1d");
        if (codec) return codec;
    }
    return avcodec_find_decoder(id);
}

static int open_codec(Decoder *d, int hardware, char *error, size_t error_size) {
    const AVCodecParameters *par = d->format->streams[d->stream]->codecpar;
    const AVCodec *codec = NULL;
    AVBufferRef *device = NULL;
    if (hardware && d->hooks.device) {
        codec = find_decoder(par->codec_id, 1);
        if (codec && hardware_capable(codec, d->hooks.device_type)) device = d->hooks.device(d->hooks.opaque);
    }
    if (!device) codec = find_decoder(par->codec_id, 0);
    if (!codec) {
        snprintf(error, error_size, "Tuck can't decode %s video.", avcodec_get_name(par->codec_id));
        return 0;
    }
    AVCodecContext *context = avcodec_alloc_context3(codec);
    if (!context || avcodec_parameters_to_context(context, par) < 0) {
        avcodec_free_context(&context);
        av_buffer_unref(&device);
        snprintf(error, error_size, "Out of memory while opening the video.");
        return 0;
    }
    context->pkt_timebase = d->time_base;
    context->opaque = d;
    if (device) {
        context->hw_device_ctx = device;
        context->get_format = choose_format;
        context->thread_count = 1;
        /* the candidate frame before a seek target holds one decoder surface while it waits */
        context->extra_hw_frames = 2;
    } else {
        context->thread_count = 0;
    }
    if (avcodec_open2(context, codec, NULL) < 0) {
        avcodec_free_context(&context);
        if (hardware) return open_codec(d, 0, error, error_size);
        snprintf(error, error_size, "The %s decoder could not start.", codec->name);
        return 0;
    }
    avcodec_free_context(&d->codec);
    d->codec = context;
    pthread_mutex_lock(&d->lock);
    d->hardware_codec = device != NULL;
    d->frames_seen = 0;
    d->hardware_frames = 0;
    snprintf(d->codec_name, sizeof(d->codec_name), "%s", codec->name);
    pthread_mutex_unlock(&d->lock);
    return 1;
}

static void queue_drop_head(Decoder *d) {
    decoded_frame_clear(&d->queue[d->head]);
    d->head = (d->head + 1) % QUEUE_LIMIT;
    d->count--;
}

/* 0 when the generation was superseded while waiting for room; the frame is freed then */
static int queue_put(Decoder *d, DecodedFrame *item) {
    pthread_mutex_lock(&d->lock);
    while (d->count >= d->capacity && !superseded(d, item->generation)) pthread_cond_wait(&d->changed, &d->lock);
    if (superseded(d, item->generation)) {
        pthread_mutex_unlock(&d->lock);
        decoded_frame_clear(item);
        return 0;
    }
    d->queue[(d->head + d->count) % QUEUE_LIMIT] = *item;
    d->count++;
    d->frames_seen = 1;
    d->hardware_frames = item->hardware;
    pthread_mutex_unlock(&d->lock);
    memset(item, 0, sizeof(*item));
    if (d->hooks.wake) d->hooks.wake(d->hooks.opaque);
    return 1;
}

/* a copy the queue may hold: hardware surfaces belong to the decoder and are copied out */
static int keep(Decoder *d, const AVFrame *frame, double time, uint64_t generation, DecodedFrame *out) {
    int hardware = frame->format == d->hooks.hardware_format && frame->hw_frames_ctx;
    AVFrame *kept = hardware ? d->hooks.keep(d->hooks.opaque, frame) : av_frame_clone(frame);
    if (!kept) {
        fail(d, "A decoded frame could not be kept for display.");
        return 0;
    }
    out->frame = kept;
    out->time = time;
    out->generation = generation;
    out->hardware = hardware;
    out->sw_format = hardware ? ((AVHWFramesContext *)frame->hw_frames_ctx->data)->sw_format : frame->format;
    return 1;
}

static int queue_frame(Decoder *d, DecodedFrame *item) {
    double time = item->time;
    if (!queue_put(d, item)) return 0;
    d->started = 1;
    if (d->cadence > 0) d->next += (floor((time - d->next) / d->cadence + 1e-5) + 1) * d->cadence;
    return 1;
}

/* 0 stops work on this generation: it was superseded, the player is closing, or keeping failed */
static int deliver(Decoder *d, AVFrame *frame, uint64_t generation) {
    int64_t pts = frame->best_effort_timestamp != AV_NOPTS_VALUE ? frame->best_effort_timestamp : frame->pts;
    if (pts == AV_NOPTS_VALUE) return 1;
    double time = pts * av_q2d(d->time_base) - d->start;
    if (!d->started) {
        if (time <= d->target + 1e-6) {
            /* a reference is enough until it turns out to be the frame showing at the target */
            decoded_frame_clear(&d->candidate);
            d->candidate.frame = av_frame_clone(frame);
            d->candidate.time = time;
            if (!d->candidate.frame) return 0;
            if (fabs(time - d->target) > 1e-6) return 1;
        }
        DecodedFrame first = {0};
        if (d->candidate.frame) {
            int ok = keep(d, d->candidate.frame, d->candidate.time, generation, &first);
            double candidate_time = d->candidate.time;
            decoded_frame_clear(&d->candidate);
            if (!ok || !queue_frame(d, &first)) return 0;
            if (candidate_time >= time) return 1;
        }
    }
    if (d->started && time + 1e-6 < d->next) return 1;
    DecodedFrame item = {0};
    return keep(d, frame, time, generation, &item) && queue_frame(d, &item);
}

static int decode(Decoder *d, const AVPacket *packet, AVFrame *frame, uint64_t generation) {
    for (;;) {
        int sent = avcodec_send_packet(d->codec, packet);
        int again = sent == AVERROR(EAGAIN);
        if (sent < 0 && !again && sent != AVERROR_EOF) return sent;
        for (;;) {
            int got = avcodec_receive_frame(d->codec, frame);
            if (got == AVERROR(EAGAIN) || got == AVERROR_EOF) break;
            if (got < 0) return got;
            int kept = deliver(d, frame, generation);
            av_frame_unref(frame);
            if (!kept || superseded(d, generation)) return 0;
        }
        if (!again) return 0;
    }
}

static int restart(Decoder *d, double target, uint64_t generation) {
    decoded_frame_clear(&d->candidate);
    d->generation = generation;
    d->target = target;
    d->next = target;
    d->started = 0;
    pthread_mutex_lock(&d->lock);
    d->ended = 0;
    pthread_mutex_unlock(&d->lock);
    int64_t timestamp = llround((target + d->start) / av_q2d(d->time_base));
    if (av_seek_frame(d->format, d->stream, timestamp, AVSEEK_FLAG_BACKWARD) < 0) {
        int64_t position = llround((target + d->start) * AV_TIME_BASE);
        if (avformat_seek_file(d->format, -1, INT64_MIN, position, position, 0) < 0) {
            fail(d, "The video could not seek to that position.");
            return 0;
        }
    }
    avcodec_flush_buffers(d->codec);
    return 1;
}

static void decode_failed(Decoder *d, int code) {
    if (d->hardware_codec) {
        /* the GPU can't decode this stream after all; start over in software from the same spot */
        char error[160];
        if (open_codec(d, 0, error, sizeof(error))) {
            d->generation = 0;
            return;
        }
    }
    if (code == AVERROR_INVALIDDATA && ++d->bad_packets < BAD_PACKET_LIMIT) return;
    fail(d, "The video could not be decoded.");
}

static void finish_stream(Decoder *d, AVFrame *frame, uint64_t generation) {
    int result = decode(d, NULL, frame, generation);
    if (result < 0) decode_failed(d, result);
    if (!d->started && d->candidate.frame && !superseded(d, generation)) {
        DecodedFrame last = {0};
        if (keep(d, d->candidate.frame, d->candidate.time, generation, &last)) queue_frame(d, &last);
        decoded_frame_clear(&d->candidate);
    }
    pthread_mutex_lock(&d->lock);
    if (generation == atomic_load(&d->requested_generation)) d->ended = 1;
    pthread_mutex_unlock(&d->lock);
}

static void *worker(void *opaque) {
    Decoder *d = opaque;
    AVPacket *packet = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    if (!packet || !frame) fail(d, "Out of memory while decoding.");
    while (packet && frame) {
        pthread_mutex_lock(&d->lock);
        while (!atomic_load(&d->closing) &&
               (!atomic_load(&d->requested_generation) ||
                (atomic_load(&d->requested_generation) == d->generation && (d->ended || d->failed))))
            pthread_cond_wait(&d->changed, &d->lock);
        uint64_t generation = atomic_load(&d->requested_generation);
        double target = d->requested_time;
        pthread_mutex_unlock(&d->lock);
        if (atomic_load(&d->closing)) break;
        if (generation != d->generation && !restart(d, target, generation)) continue;
        int result = av_read_frame(d->format, packet);
        if (result == AVERROR_EOF) {
            finish_stream(d, frame, generation);
            continue;
        }
        if (result < 0) {
            if (result != AVERROR(EAGAIN) && !atomic_load(&d->closing)) fail(d, "The video file could not be read.");
            continue;
        }
        if (packet->stream_index == d->stream) {
            result = decode(d, packet, frame, generation);
            if (result < 0) decode_failed(d, result);
            else d->bad_packets = 0;
        }
        av_packet_unref(packet);
    }
    av_packet_free(&packet);
    av_frame_free(&frame);
    return NULL;
}

Decoder *decoder_open(const char *path, const DecoderHooks *hooks, char *error, size_t error_size) {
    Decoder *d = calloc(1, sizeof(*d));
    if (!d) {
        snprintf(error, error_size, "Out of memory while opening the video.");
        return NULL;
    }
    d->hooks = *hooks;
    d->capacity = QUEUE_LIMIT;
    pthread_mutex_init(&d->lock, NULL);
    pthread_cond_init(&d->changed, NULL);
    d->format = avformat_alloc_context();
    if (!d->format) goto oom;
    d->format->interrupt_callback = (AVIOInterruptCB){interrupted, d};
    if (avformat_open_input(&d->format, path, NULL, NULL) < 0) {
        snprintf(error, error_size, "The video file could not be opened.");
        goto failed;
    }
    if (avformat_find_stream_info(d->format, NULL) < 0) {
        snprintf(error, error_size, "The video file could not be read.");
        goto failed;
    }
    d->stream = av_find_best_stream(d->format, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    if (d->stream < 0) {
        snprintf(error, error_size, "The file has no video.");
        goto failed;
    }
    AVStream *stream = d->format->streams[d->stream];
    for (unsigned i = 0; i < d->format->nb_streams; i++)
        if ((int)i != d->stream) d->format->streams[i]->discard = AVDISCARD_ALL;
    d->time_base = stream->time_base;
    d->start = d->format->start_time == AV_NOPTS_VALUE ? 0 : (double)d->format->start_time / AV_TIME_BASE;
    AVRational rate = av_guess_frame_rate(d->format, stream, NULL);
    d->frame_rate = rate.num > 0 && rate.den > 0 ? av_q2d(rate) : 0;
    if (!open_codec(d, 1, error, error_size)) goto failed;
    if (pthread_create(&d->thread, NULL, worker, d) != 0) goto oom;
    d->thread_started = 1;
    return d;
oom:
    snprintf(error, error_size, "Out of memory while opening the video.");
failed:
    decoder_close(d);
    return NULL;
}

void decoder_close(Decoder *d) {
    if (!d) return;
    pthread_mutex_lock(&d->lock);
    atomic_store(&d->closing, 1);
    pthread_cond_broadcast(&d->changed);
    pthread_mutex_unlock(&d->lock);
    if (d->thread_started) pthread_join(d->thread, NULL);
    while (d->count) queue_drop_head(d);
    decoded_frame_clear(&d->candidate);
    avcodec_free_context(&d->codec);
    avformat_close_input(&d->format);
    pthread_cond_destroy(&d->changed);
    pthread_mutex_destroy(&d->lock);
    free(d);
}

void decoder_set_cadence(Decoder *d, double interval) {
    pthread_mutex_lock(&d->lock);
    d->cadence = interval > 0 ? interval : 0;
    double rate = d->cadence > 0 ? 1 / d->cadence : d->frame_rate;
    d->capacity = playback_video_capacity((int)lround(rate > 0 ? rate : 60));
    if (d->capacity < 2) d->capacity = 2;
    pthread_cond_broadcast(&d->changed);
    pthread_mutex_unlock(&d->lock);
}

void decoder_seek(Decoder *d, double seconds, uint64_t generation) {
    pthread_mutex_lock(&d->lock);
    atomic_store(&d->requested_generation, generation);
    d->requested_time = seconds;
    d->ended = 0;
    pthread_cond_broadcast(&d->changed);
    pthread_mutex_unlock(&d->lock);
}

int decoder_take(Decoder *d, double time, uint64_t generation, int first, DecodedFrame *out) {
    pthread_mutex_lock(&d->lock);
    while (d->count && d->queue[d->head].generation != generation) queue_drop_head(d);
    int found = d->count && (first || d->queue[d->head].time <= time);
    if (found) {
        while (!first && d->count > 1 && d->queue[(d->head + 1) % QUEUE_LIMIT].time <= time) queue_drop_head(d);
        *out = d->queue[d->head];
        memset(&d->queue[d->head], 0, sizeof(d->queue[d->head]));
        d->head = (d->head + 1) % QUEUE_LIMIT;
        d->count--;
        pthread_cond_broadcast(&d->changed);
    }
    pthread_mutex_unlock(&d->lock);
    return found;
}

void decoder_info(Decoder *d, DecoderInfo *info) {
    pthread_mutex_lock(&d->lock);
    /* a hardware decoder hands out software frames when the GPU can't do a stream */
    int hardware = d->frames_seen ? d->hardware_frames : d->hardware_codec;
    snprintf(info->name, sizeof(info->name), "%s %s", d->codec_name,
             hardware ? av_hwdevice_get_type_name(d->hooks.device_type) : "software");
    snprintf(info->error, sizeof(info->error), "%s", d->error);
    info->frame_rate = d->frame_rate;
    info->hardware = d->hardware_frames;
    info->failed = d->failed;
    info->ended = d->ended;
    pthread_mutex_unlock(&d->lock);
}
