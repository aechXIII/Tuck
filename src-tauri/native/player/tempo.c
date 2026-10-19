#include "tempo.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>

#define SAMPLE_RATE 48000
/* one atempo stage takes 0.5 to 100 times; slower speeds chain halves */
#define STAGE_MIN 0.5

struct Tempo {
    AVFilterGraph *graph;
    AVFilterContext *source;
    AVFilterContext *sink;
    AVFrame *out;
    int64_t fed;
};

void tempo_close(Tempo *t) {
    if (!t) return;
    av_frame_free(&t->out);
    avfilter_graph_free(&t->graph);
    free(t);
}

static int link_stages(Tempo *t, double rate) {
    char description[160] = "";
    size_t used = 0;
    while (rate < STAGE_MIN - 1e-9 && used < sizeof(description)) {
        used += (size_t)snprintf(description + used, sizeof(description) - used, "atempo=%g,", STAGE_MIN);
        rate /= STAGE_MIN;
    }
    if (used >= sizeof(description)) return 0;
    /* the output keeps the input's format, so the device takes it as it is */
    snprintf(description + used, sizeof(description) - used,
             "atempo=%.6f,aformat=sample_fmts=flt:channel_layouts=stereo:sample_rates=%d", rate, SAMPLE_RATE);
    AVFilterInOut *inputs = avfilter_inout_alloc();
    AVFilterInOut *outputs = avfilter_inout_alloc();
    int linked = 0;
    if (inputs && outputs) {
        outputs->name = av_strdup("in");
        outputs->filter_ctx = t->source;
        inputs->name = av_strdup("out");
        inputs->filter_ctx = t->sink;
        linked = outputs->name && inputs->name &&
                 avfilter_graph_parse_ptr(t->graph, description, &inputs, &outputs, NULL) >= 0 &&
                 avfilter_graph_config(t->graph, NULL) >= 0;
    }
    avfilter_inout_free(&inputs);
    avfilter_inout_free(&outputs);
    return linked;
}

Tempo *tempo_open(double rate) {
    if (!(rate > 0)) return NULL;
    Tempo *t = calloc(1, sizeof(*t));
    if (!t) return NULL;
    t->graph = avfilter_graph_alloc();
    t->out = av_frame_alloc();
    const AVFilter *source = avfilter_get_by_name("abuffer");
    const AVFilter *sink = avfilter_get_by_name("abuffersink");
    char args[128];
    snprintf(args, sizeof(args), "sample_rate=%d:sample_fmt=flt:channel_layout=stereo:time_base=1/%d", SAMPLE_RATE,
             SAMPLE_RATE);
    if (!t->graph || !t->out || !source || !sink ||
        avfilter_graph_create_filter(&t->source, source, "in", args, NULL, t->graph) < 0 ||
        avfilter_graph_create_filter(&t->sink, sink, "out", NULL, NULL, t->graph) < 0 || !link_stages(t, rate)) {
        tempo_close(t);
        return NULL;
    }
    return t;
}

int tempo_feed(Tempo *t, const float *samples, size_t frames) {
    if (!samples) return av_buffersrc_add_frame_flags(t->source, NULL, 0) >= 0;
    if (!frames) return 1;
    AVFrame *frame = av_frame_alloc();
    if (!frame) return 0;
    frame->format = AV_SAMPLE_FMT_FLT;
    frame->sample_rate = SAMPLE_RATE;
    frame->nb_samples = (int)frames;
    frame->pts = t->fed;
    AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
    int fed = av_channel_layout_copy(&frame->ch_layout, &stereo) >= 0 && av_frame_get_buffer(frame, 0) >= 0;
    if (fed) {
        memcpy(frame->data[0], samples, frames * 2 * sizeof(float));
        /* the filter takes the buffer over and leaves the frame empty */
        fed = av_buffersrc_add_frame_flags(t->source, frame, 0) >= 0;
    }
    av_frame_free(&frame);
    if (fed) t->fed += (int64_t)frames;
    return fed;
}

const float *tempo_take(Tempo *t, size_t *frames) {
    av_frame_unref(t->out);
    *frames = 0;
    if (av_buffersink_get_frame(t->sink, t->out) < 0) return NULL;
    *frames = (size_t)t->out->nb_samples;
    return (const float *)t->out->data[0];
}
