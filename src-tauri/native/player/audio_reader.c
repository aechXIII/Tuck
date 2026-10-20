#include "audio_reader.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>

#include "mix.h"

/* broken packets in a row before the sound counts as undecodable */
#define BAD_PACKET_LIMIT 64
/* a read this far past what is decoded seeks instead of decoding its way there */
#define SEEK_AHEAD_SECONDS 1.0
/* half a sample: positions this close count as the same sample */
#define HALF_SAMPLE (0.5 / MIX_RATE)

struct AudioReader {
    AVFormatContext *format;
    AVCodecContext *codec;
    int stream;
    AVRational time_base;
    /* the file's start time, which the picture's decoder takes off its frame times too */
    double start;
    SwrContext *resampler;
    AVChannelLayout resampler_layout;
    int resampler_rate, resampler_format;
    AVPacket *packet;
    AVFrame *frame;
    float *converted;
    int converted_capacity;
    /* decoded stereo frames; buffer[0] is file second `time`, and `next` is just after the last */
    float *buffer;
    size_t count, capacity;
    double time, next;
    /* the earliest file second the reader can answer without going back: the file's start, where it
       last sought to, or the end of the sound already used. No sound lies between it and `time`. */
    double earliest;
    int ended, bad_packets;
};

void audio_reader_close(AudioReader *r) {
    if (!r) return;
    swr_free(&r->resampler);
    av_channel_layout_uninit(&r->resampler_layout);
    av_packet_free(&r->packet);
    av_frame_free(&r->frame);
    free(r->converted);
    free(r->buffer);
    avcodec_free_context(&r->codec);
    avformat_close_input(&r->format);
    free(r);
}

/* the file's `nth` audio stream, as the export numbers them (0:a:N) */
static int nth_audio_stream(AVFormatContext *format, int nth) {
    int seen = 0;
    for (unsigned i = 0; i < format->nb_streams; i++) {
        if (format->streams[i]->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) continue;
        if (seen++ == nth) return (int)i;
    }
    return -1;
}

AudioReader *audio_reader_open(const char *path, int stream, int (*interrupted)(void *), void *opaque,
                               char *error, size_t error_size) {
    AudioReader *r = calloc(1, sizeof(*r));
    if (!r) {
        snprintf(error, error_size, "Out of memory while opening the sound.");
        return NULL;
    }
    r->format = avformat_alloc_context();
    r->packet = av_packet_alloc();
    r->frame = av_frame_alloc();
    if (!r->format || !r->packet || !r->frame) {
        snprintf(error, error_size, "Out of memory while opening the sound.");
        goto failed;
    }
    if (interrupted) r->format->interrupt_callback = (AVIOInterruptCB){interrupted, opaque};
    if (avformat_open_input(&r->format, path, NULL, NULL) < 0 || avformat_find_stream_info(r->format, NULL) < 0) {
        snprintf(error, error_size, "The sound could not be read.");
        goto failed;
    }
    r->stream = nth_audio_stream(r->format, stream);
    if (r->stream < 0) {
        snprintf(error, error_size, "The file has no sound stream %d.", stream + 1);
        goto failed;
    }
    for (unsigned i = 0; i < r->format->nb_streams; i++)
        if ((int)i != r->stream) r->format->streams[i]->discard = AVDISCARD_ALL;
    AVStream *chosen = r->format->streams[r->stream];
    r->time_base = chosen->time_base;
    r->earliest = -INFINITY;
    r->start = r->format->start_time == AV_NOPTS_VALUE ? 0 : (double)r->format->start_time / AV_TIME_BASE;
    const AVCodec *codec = avcodec_find_decoder(chosen->codecpar->codec_id);
    if (!codec) {
        snprintf(error, error_size, "This kind of sound can't be played.");
        goto failed;
    }
    r->codec = avcodec_alloc_context3(codec);
    if (!r->codec || avcodec_parameters_to_context(r->codec, chosen->codecpar) < 0 ||
        avcodec_open2(r->codec, codec, NULL) < 0) {
        snprintf(error, error_size, "The sound decoder could not start.");
        goto failed;
    }
    return r;
failed:
    audio_reader_close(r);
    return NULL;
}

static void drop(AudioReader *r, size_t frames) {
    if (frames >= r->count) {
        r->time += (double)r->count / MIX_RATE;
        r->count = 0;
    } else {
        memmove(r->buffer, r->buffer + frames * 2, (r->count - frames) * 2 * sizeof(float));
        r->count -= frames;
        r->time += (double)frames / MIX_RATE;
    }
    r->earliest = r->time;
}

static int seek(AudioReader *r, double seconds, char *error, size_t error_size) {
    int64_t timestamp = llround((seconds + r->start) / av_q2d(r->time_base));
    if (av_seek_frame(r->format, r->stream, timestamp, AVSEEK_FLAG_BACKWARD) < 0) {
        int64_t position = llround((seconds + r->start) * AV_TIME_BASE);
        if (avformat_seek_file(r->format, -1, INT64_MIN, position, position, 0) < 0) {
            snprintf(error, error_size, "The sound could not seek to that position.");
            return 0;
        }
    }
    avcodec_flush_buffers(r->codec);
    /* the resampler holds samples from the old position */
    swr_free(&r->resampler);
    r->count = 0;
    r->time = r->next = r->earliest = seconds;
    r->ended = 0;
    r->bad_packets = 0;
    return 1;
}

static int prepare_resampler(AudioReader *r, const AVFrame *frame) {
    if (r->resampler && r->resampler_rate == frame->sample_rate && r->resampler_format == frame->format &&
        !av_channel_layout_compare(&r->resampler_layout, &frame->ch_layout))
        return 1;
    swr_free(&r->resampler);
    AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
    if (swr_alloc_set_opts2(&r->resampler, &stereo, AV_SAMPLE_FMT_FLT, MIX_RATE, &frame->ch_layout, frame->format,
                            frame->sample_rate, 0, NULL) < 0 ||
        swr_init(r->resampler) < 0) {
        swr_free(&r->resampler);
        return 0;
    }
    av_channel_layout_uninit(&r->resampler_layout);
    if (av_channel_layout_copy(&r->resampler_layout, &frame->ch_layout) < 0) {
        swr_free(&r->resampler);
        return 0;
    }
    r->resampler_rate = frame->sample_rate;
    r->resampler_format = frame->format;
    return 1;
}

/* converts a decoded frame and adds it to the buffer */
static int keep(AudioReader *r, const AVFrame *frame, char *error, size_t error_size) {
    if (!prepare_resampler(r, frame)) {
        snprintf(error, error_size, "The sound could not be converted for the mix.");
        return 0;
    }
    double pts = frame->best_effort_timestamp == AV_NOPTS_VALUE
                     ? r->next
                     : frame->best_effort_timestamp * av_q2d(r->time_base) - r->start;
    /* the first sample out of the resampler is older than this frame by its delay */
    double first = pts - (double)swr_get_delay(r->resampler, MIX_RATE) / MIX_RATE;
    int capacity = swr_get_out_samples(r->resampler, frame->nb_samples);
    if (capacity < 0) return 0;
    if (capacity > r->converted_capacity) {
        float *grown = realloc(r->converted, (size_t)capacity * 2 * sizeof(float));
        if (!grown) {
            snprintf(error, error_size, "Out of memory while playing sound.");
            return 0;
        }
        r->converted = grown;
        r->converted_capacity = capacity;
    }
    uint8_t *out = (uint8_t *)r->converted;
    int got = swr_convert(r->resampler, &out, capacity, (const uint8_t **)frame->extended_data, frame->nb_samples);
    if (got < 0) {
        snprintf(error, error_size, "The sound could not be converted for the mix.");
        return 0;
    }
    if (r->count + (size_t)got > r->capacity) {
        size_t grown_capacity = (r->count + (size_t)got) * 2;
        float *grown = realloc(r->buffer, grown_capacity * 2 * sizeof(float));
        if (!grown) {
            snprintf(error, error_size, "Out of memory while playing sound.");
            return 0;
        }
        r->buffer = grown;
        r->capacity = grown_capacity;
    }
    /* an empty buffer starts where this frame does; after that frames follow each other */
    if (!r->count) r->time = first;
    memcpy(r->buffer + r->count * 2, r->converted, (size_t)got * 2 * sizeof(float));
    r->count += (size_t)got;
    r->next = r->time + (double)r->count / MIX_RATE;
    return 1;
}

/* decodes the next frame into the buffer: 1 when there may be more, 0 at the end, -1 on failure */
static int decode_more(AudioReader *r, char *error, size_t error_size) {
    for (;;) {
        int result = avcodec_receive_frame(r->codec, r->frame);
        if (result == 0) {
            int kept = keep(r, r->frame, error, error_size);
            av_frame_unref(r->frame);
            return kept ? 1 : -1;
        }
        if (result == AVERROR_EOF) {
            r->ended = 1;
            return 0;
        }
        if (result != AVERROR(EAGAIN)) {
            snprintf(error, error_size, "The sound could not be decoded.");
            return -1;
        }
        result = av_read_frame(r->format, r->packet);
        if (result == AVERROR_EOF) {
            avcodec_send_packet(r->codec, NULL);
            continue;
        }
        if (result < 0) {
            snprintf(error, error_size, "The sound could not be read.");
            return -1;
        }
        if (r->packet->stream_index != r->stream) {
            av_packet_unref(r->packet);
            continue;
        }
        result = avcodec_send_packet(r->codec, r->packet);
        av_packet_unref(r->packet);
        if (result < 0 && result != AVERROR(EAGAIN)) {
            if (result != AVERROR_INVALIDDATA || ++r->bad_packets >= BAD_PACKET_LIMIT) {
                snprintf(error, error_size, "The sound could not be decoded.");
                return -1;
            }
        } else {
            r->bad_packets = 0;
        }
    }
}

int audio_reader_read(AudioReader *r, double seconds, float *samples, size_t frames, char *error,
                      size_t error_size) {
    size_t filled = 0;
    while (filled < frames) {
        double want = seconds + (double)filled / MIX_RATE;
        if (r->count) {
            double offset = (want - r->time) * MIX_RATE;
            if (offset < -0.5 && want < r->earliest - HALF_SAMPLE) {
                /* what is buffered was read ahead of an earlier position: go back for this one */
                if (!seek(r, want, error, error_size)) return 0;
                continue;
            }
            if (offset < -0.5) {
                /* the sound starts later than asked: silence until it does */
                size_t gap = (size_t)ceil(-offset - 0.5);
                if (gap > frames - filled) gap = frames - filled;
                if (!gap) gap = 1;
                memset(samples + filled * 2, 0, gap * 2 * sizeof(float));
                filled += gap;
                continue;
            }
            size_t skip = (size_t)llround(offset);
            if (skip < r->count) {
                drop(r, skip);
                size_t take = r->count < frames - filled ? r->count : frames - filled;
                memcpy(samples + filled * 2, r->buffer, take * 2 * sizeof(float));
                drop(r, take);
                filled += take;
                continue;
            }
            /* everything decoded is before what is asked for */
            drop(r, r->count);
        }
        if (r->ended && want >= r->next - HALF_SAMPLE) break;
        if (want < r->next - HALF_SAMPLE || want > r->next + SEEK_AHEAD_SECONDS || r->ended) {
            if (!seek(r, want, error, error_size)) return 0;
        }
        if (decode_more(r, error, error_size) < 0) return 0;
    }
    if (filled < frames) memset(samples + filled * 2, 0, (frames - filled) * 2 * sizeof(float));
    return 1;
}
