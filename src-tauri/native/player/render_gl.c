/* Linux: libplacebo's OpenGL backend drawing into the shell's GtkGLArea on GTK's main thread.
   With an EGL context, VAAPI frames reach OpenGL as DMA-BUFs and never pass through system
   memory; with a GLX context (X11 without EGL) they are copied down and uploaded instead. */
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>

#include <libavutil/hwcontext.h>
#include <libplacebo/opengl.h>
#include <libplacebo/renderer.h>
#include <libplacebo/utils/libav.h>

#include "framebuffer_cache.h"
#include "render.h"

#define GL_FRAMEBUFFER 0x8D40
#define GL_DRAW_FRAMEBUFFER_BINDING 0x8CA6
#define GL_RGBA8 0x8058

typedef void (*GetIntegerv)(unsigned target, int *value);
typedef void (*BindFramebuffer)(unsigned target, unsigned framebuffer);
typedef void *(*EglCurrent)(void);
typedef pl_voidfunc_t (*GetProcAddress)(const char *name);

struct TuckGlRenderer {
    pl_log log;
    pl_opengl gl;
    pl_renderer renderer;
    GetIntegerv get_integer;
    BindFramebuffer bind_framebuffer;
    int egl;
    FramebufferCacheState cache;
    pl_tex target;
    pl_tex uploads[4];
    AVFrame *download;
    char error[160];
};

/* the copy GTK already loaded, or the system library of that name */
static void *library(const char *name) {
    void *handle = dlopen(name, RTLD_NOW | RTLD_NOLOAD);
    return handle ? handle : dlopen(name, RTLD_NOW | RTLD_LOCAL);
}

TuckGlRenderer *tuck_gl_renderer_create(char *error, size_t error_size) {
    TuckGlRenderer *r = calloc(1, sizeof(*r));
    if (!r) {
        snprintf(error, error_size, "Out of memory while starting the preview.");
        return NULL;
    }
    void *egl = library("libEGL.so.1");
    EglCurrent egl_context = egl ? (EglCurrent)dlsym(egl, "eglGetCurrentContext") : NULL;
    EglCurrent egl_display = egl ? (EglCurrent)dlsym(egl, "eglGetCurrentDisplay") : NULL;
    GetProcAddress get_proc = NULL;
    void *context = egl_context ? egl_context() : NULL;
    if (context && egl_display) {
        r->egl = 1;
        get_proc = (GetProcAddress)dlsym(egl, "eglGetProcAddress");
    } else {
        void *glx = library("libGLX.so.0");
        if (!glx) glx = library("libGL.so.1");
        get_proc = glx ? (GetProcAddress)dlsym(glx, "glXGetProcAddressARB") : NULL;
    }
    if (!get_proc) {
        snprintf(error, error_size, "The preview found no OpenGL to draw with.");
        goto failed;
    }
    r->get_integer = (GetIntegerv)get_proc("glGetIntegerv");
    r->bind_framebuffer = (BindFramebuffer)get_proc("glBindFramebuffer");
    r->download = av_frame_alloc();
    r->log = pl_log_create(PL_API_VER, pl_log_params(.log_cb = pl_log_simple, .log_level = PL_LOG_WARN));
    r->gl = pl_opengl_create(r->log, pl_opengl_params(
        .get_proc_addr = get_proc,
        .egl_display = r->egl ? egl_display() : NULL,
        .egl_context = r->egl ? context : NULL));
    if (!r->get_integer || !r->bind_framebuffer || !r->download || !r->gl) {
        snprintf(error, error_size, "The preview could not use this OpenGL context.");
        goto failed;
    }
    r->renderer = pl_renderer_create(r->log, r->gl->gpu);
    if (!r->renderer) {
        snprintf(error, error_size, "The preview renderer could not start.");
        goto failed;
    }
    return r;
failed:
    tuck_gl_renderer_destroy(r);
    return NULL;
}

void tuck_gl_renderer_destroy(TuckGlRenderer *r) {
    if (!r) return;
    if (r->gl) {
        pl_gpu gpu = r->gl->gpu;
        pl_tex_destroy(gpu, &r->target);
        for (int i = 0; i < 4; i++) pl_tex_destroy(gpu, &r->uploads[i]);
    }
    pl_renderer_destroy(&r->renderer);
    pl_opengl_destroy(&r->gl);
    pl_log_destroy(&r->log);
    av_frame_free(&r->download);
    free(r);
}

int tuck_gl_renderer_imports_frames(TuckGlRenderer *r) {
    return r->egl;
}

const char *gl_renderer_error(TuckGlRenderer *r) {
    return r->error;
}

/* GTK binds the area's framebuffer before each render; keep one wrapper per framebuffer and size */
static int wrap_target(TuckGlRenderer *r, const TuckVideoTarget *t, int *framebuffer) {
    r->get_integer(GL_DRAW_FRAMEBUFFER_BINDING, framebuffer);
    if (framebuffer_cache_matches(&r->cache, (unsigned)*framebuffer, t->width, t->height)) return 1;
    pl_tex_destroy(r->gl->gpu, &r->target);
    framebuffer_cache_reset(&r->cache);
    r->target = pl_opengl_wrap(r->gl->gpu, pl_opengl_wrap_params(
        .framebuffer = (unsigned)*framebuffer, .width = t->width, .height = t->height, .iformat = GL_RGBA8));
    if (!r->target) {
        snprintf(r->error, sizeof(r->error), "The preview could not draw into its area.");
        return 0;
    }
    framebuffer_cache_created(&r->cache, (unsigned)*framebuffer, t->width, t->height);
    return 1;
}

void tuck_gl_renderer_clear(TuckGlRenderer *r, const TuckVideoTarget *t) {
    int framebuffer = 0;
    if (!wrap_target(r, t, &framebuffer)) return;
    pl_tex_clear(r->gl->gpu, r->target, (float[4]){0, 0, 0, 1});
    r->bind_framebuffer(GL_FRAMEBUFFER, (unsigned)framebuffer);
}

RenderOutcome gl_renderer_draw(TuckGlRenderer *r, const DecodedFrame *item, const TuckVideoTarget *t,
                               const struct pl_custom_lut *lut, double split, const TuckVideoView *view) {
    int framebuffer = 0;
    if (t->width < 1 || t->height < 1 || t->picture_width < 1 || t->picture_height < 1) return RENDER_DEFERRED;
    if (!wrap_target(r, t, &framebuffer)) return RENDER_FAILED;
    pl_gpu gpu = r->gl->gpu;
    const AVFrame *frame = item->frame;
    if (item->hardware && !r->egl) {
        av_frame_unref(r->download);
        if (av_hwframe_transfer_data(r->download, frame, 0) < 0 || av_frame_copy_props(r->download, frame) < 0) {
            snprintf(r->error, sizeof(r->error), "The preview could not copy the decoded picture.");
            return RENDER_FAILED;
        }
        frame = r->download;
    }
    struct pl_frame image;
    if (!pl_map_avframe_ex(gpu, &image, pl_avframe_params(.frame = frame, .tex = r->uploads))) {
        snprintf(r->error, sizeof(r->error), "The preview could not read the decoded picture.");
        return RENDER_FAILED;
    }
    struct pl_frame target = {
        .num_planes = 1,
        .planes = {{.texture = r->target, .components = 4, .component_mapping = {0, 1, 2, 3}}},
        .repr = pl_color_repr_rgb,
        .color = pl_color_space_srgb,
    };
    pl_rect2df picture = {
        (float)t->picture_x, (float)t->picture_y,
        (float)(t->picture_x + t->picture_width), (float)(t->picture_y + t->picture_height),
    };
    render_place_view(&image, &picture, 0, frame->sample_aspect_ratio, view);
    /* OpenGL counts rows from the bottom; a flipped rectangle draws the picture upright */
    target.crop = (pl_rect2df){picture.x0, (float)t->height - picture.y0, picture.x1, (float)t->height - picture.y1};
    int ok = render_with_lut(r->renderer, &image, &target, lut, split);
    pl_unmap_avframe(gpu, &image);
    pl_gpu_flush(gpu);
    r->bind_framebuffer(GL_FRAMEBUFFER, (unsigned)framebuffer);
    if (!ok) {
        snprintf(r->error, sizeof(r->error), "The preview could not draw the picture.");
        return RENDER_FAILED;
    }
    return RENDER_SUBMITTED;
}
