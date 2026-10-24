/* Windows: libplacebo's D3D11 backend drawing into the preview's child window. D3D11VA decodes on
   the same device, and both share one lock around the immediate context. The application presents
   each frame itself with Present(0, 0): libplacebo's own present waits for vsync every frame and
   slowly fell behind the clock at high frame rates. */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <d3d10.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <stdio.h>
#include <stdlib.h>

#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_d3d11va.h>
#include <libplacebo/d3d11.h>
#include <libplacebo/renderer.h>
#include <libplacebo/utils/libav.h>

#include "render.h"

struct Renderer {
    HWND window;
    pl_log log;
    pl_d3d11 d3d11;
    pl_swapchain swapchain;
    IDXGISwapChain *dxgi;
    pl_renderer renderer;
    ID3D11DeviceContext *context;
    /* FFmpeg's decoder and libplacebo share the immediate context; Present never holds this */
    CRITICAL_SECTION gpu;
    /* decoder thread only: owned textures that frames are copied into */
    AVBufferPool *snapshots;
    D3D11_TEXTURE2D_DESC snapshot_desc;
    /* render thread only: the texture libplacebo samples, and its wrapped planes */
    ID3D11Texture2D *sampled;
    D3D11_TEXTURE2D_DESC sampled_desc;
    pl_tex planes[2];
    pl_tex uploads[4];
    int width, height;
    double refresh_interval;
    char error[160];
};

static void gpu_lock(void *opaque) {
    EnterCriticalSection(&((Renderer *)opaque)->gpu);
}

static void gpu_unlock(void *opaque) {
    LeaveCriticalSection(&((Renderer *)opaque)->gpu);
}

static void client_size(HWND window, int *width, int *height) {
    RECT rect = {0};
    GetClientRect(window, &rect);
    *width = rect.right - rect.left;
    *height = rect.bottom - rect.top;
}

/* the refresh rate of the display the preview is on; 60 Hz when Windows doesn't say */
static double refresh_interval(HWND window) {
    MONITORINFOEXW monitor = {.cbSize = sizeof(monitor)};
    DEVMODEW mode = {.dmSize = sizeof(mode)};
    HMONITOR handle = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
    if (handle && GetMonitorInfoW(handle, (MONITORINFO *)&monitor) &&
        EnumDisplaySettingsW(monitor.szDevice, ENUM_CURRENT_SETTINGS, &mode) && mode.dmDisplayFrequency > 1)
        return 1.0 / mode.dmDisplayFrequency;
    return 1.0 / 60;
}

Renderer *renderer_open(void *window, char *error, size_t error_size) {
    Renderer *r = calloc(1, sizeof(*r));
    if (!r) {
        snprintf(error, error_size, "Out of memory while starting the preview.");
        return NULL;
    }
    InitializeCriticalSection(&r->gpu);
    r->window = window;
    if (!r->window || !IsWindow(r->window)) {
        snprintf(error, error_size, "The preview window is not ready.");
        goto failed;
    }
    r->log = pl_log_create(PL_API_VER, pl_log_params(.log_cb = pl_log_simple, .log_level = PL_LOG_WARN));
    r->d3d11 = pl_d3d11_create(r->log, pl_d3d11_params(
        .allow_software = false, .min_feature_level = D3D_FEATURE_LEVEL_11_0,
        .flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        .max_frame_latency = 2));
    if (!r->d3d11) {
        snprintf(error, error_size, "The graphics card could not start the preview.");
        goto failed;
    }
    ID3D11Device_GetImmediateContext(r->d3d11->device, &r->context);
    ID3D10Multithread *multithread = NULL;
    if (SUCCEEDED(ID3D11DeviceContext_QueryInterface(r->context, &IID_ID3D10Multithread, (void **)&multithread))) {
        ID3D10Multithread_SetMultithreadProtected(multithread, TRUE);
        ID3D10Multithread_Release(multithread);
    }
    client_size(r->window, &r->width, &r->height);
    if (r->width < 1) r->width = 1;
    if (r->height < 1) r->height = 1;
    r->swapchain = pl_d3d11_create_swapchain(r->d3d11, pl_d3d11_swapchain_params(
        .window = r->window, .width = r->width, .height = r->height, .disable_10bit_sdr = true));
    if (!r->swapchain) {
        snprintf(error, error_size, "The preview could not draw into its window.");
        goto failed;
    }
    r->dxgi = pl_d3d11_swapchain_unwrap(r->swapchain);
    r->renderer = pl_renderer_create(r->log, r->d3d11->gpu);
    if (!r->renderer) {
        snprintf(error, error_size, "The preview renderer could not start.");
        goto failed;
    }
    r->refresh_interval = refresh_interval(r->window);
    return r;
failed:
    renderer_close(r);
    return NULL;
}

void renderer_close(Renderer *r) {
    if (!r) return;
    if (r->d3d11) {
        pl_gpu gpu = r->d3d11->gpu;
        EnterCriticalSection(&r->gpu);
        pl_gpu_finish(gpu);
        for (int i = 0; i < 2; i++) pl_tex_destroy(gpu, &r->planes[i]);
        for (int i = 0; i < 4; i++) pl_tex_destroy(gpu, &r->uploads[i]);
        LeaveCriticalSection(&r->gpu);
    }
    /* textures still out in frames are released by the pool when those frames are freed */
    av_buffer_pool_uninit(&r->snapshots);
    if (r->sampled) ID3D11Texture2D_Release(r->sampled);
    if (r->context) ID3D11DeviceContext_Release(r->context);
    if (r->dxgi) IDXGISwapChain_Release(r->dxgi);
    pl_renderer_destroy(&r->renderer);
    pl_swapchain_destroy(&r->swapchain);
    pl_d3d11_destroy(&r->d3d11);
    pl_log_destroy(&r->log);
    DeleteCriticalSection(&r->gpu);
    free(r);
}

enum AVHWDeviceType renderer_device_type(void) {
    return AV_HWDEVICE_TYPE_D3D11VA;
}

enum AVPixelFormat renderer_hardware_format(void) {
    return AV_PIX_FMT_D3D11;
}

AVBufferRef *renderer_device(Renderer *r) {
    AVBufferRef *reference = av_hwdevice_ctx_alloc(AV_HWDEVICE_TYPE_D3D11VA);
    if (!reference) return NULL;
    AVD3D11VADeviceContext *device = ((AVHWDeviceContext *)reference->data)->hwctx;
    device->device = r->d3d11->device;
    ID3D11Device_AddRef(device->device);
    device->lock = gpu_lock;
    device->unlock = gpu_unlock;
    device->lock_ctx = r;
    if (av_hwdevice_ctx_init(reference) < 0) av_buffer_unref(&reference);
    return reference;
}

static void snapshot_free(void *opaque, uint8_t *data) {
    (void)opaque;
    ID3D11Texture2D_Release((ID3D11Texture2D *)data);
}

static AVBufferRef *snapshot_allocate(void *opaque, size_t size) {
    (void)size;
    Renderer *r = opaque;
    D3D11_TEXTURE2D_DESC desc = r->snapshot_desc;
    desc.ArraySize = 1;
    desc.MipLevels = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    desc.CPUAccessFlags = 0;
    desc.MiscFlags = 0;
    ID3D11Texture2D *texture = NULL;
    if (FAILED(ID3D11Device_CreateTexture2D(r->d3d11->device, &desc, NULL, &texture))) return NULL;
    AVBufferRef *buffer = av_buffer_create((uint8_t *)texture, sizeof(*texture), snapshot_free, NULL, 0);
    if (!buffer) ID3D11Texture2D_Release(texture);
    return buffer;
}

/* decoder surfaces go back to the decoder at once; the queue keeps its own copies on the GPU */
AVFrame *renderer_keep(Renderer *r, const AVFrame *source) {
    ID3D11Texture2D *texture = (ID3D11Texture2D *)source->data[0];
    UINT slice = (UINT)(intptr_t)source->data[1];
    D3D11_TEXTURE2D_DESC desc;
    ID3D11Texture2D_GetDesc(texture, &desc);
    if (!r->snapshots || desc.Width != r->snapshot_desc.Width || desc.Height != r->snapshot_desc.Height ||
        desc.Format != r->snapshot_desc.Format) {
        av_buffer_pool_uninit(&r->snapshots);
        r->snapshot_desc = desc;
        r->snapshots = av_buffer_pool_init2(sizeof(ID3D11Texture2D *), r, snapshot_allocate, NULL);
        if (!r->snapshots) return NULL;
    }
    AVFrame *frame = av_frame_alloc();
    if (!frame) return NULL;
    frame->buf[0] = av_buffer_pool_get(r->snapshots);
    if (!frame->buf[0] || av_frame_copy_props(frame, source) < 0) {
        av_frame_free(&frame);
        return NULL;
    }
    frame->format = AV_PIX_FMT_D3D11;
    frame->width = source->width;
    frame->height = source->height;
    frame->crop_top = source->crop_top;
    frame->crop_bottom = source->crop_bottom;
    frame->crop_left = source->crop_left;
    frame->crop_right = source->crop_right;
    frame->data[0] = frame->buf[0]->data;
    frame->data[1] = 0;
    EnterCriticalSection(&r->gpu);
    ID3D11DeviceContext_CopySubresourceRegion(r->context, (ID3D11Resource *)frame->data[0], 0, 0, 0, 0,
                                              (ID3D11Resource *)texture, slice, NULL);
    LeaveCriticalSection(&r->gpu);
    return frame;
}

/* the sampled copy and its two plane views; rebuilt only when the frame layout changes */
static int prepare_planes(Renderer *r, const D3D11_TEXTURE2D_DESC *desc) {
    if (r->sampled && desc->Width == r->sampled_desc.Width && desc->Height == r->sampled_desc.Height &&
        desc->Format == r->sampled_desc.Format)
        return 1;
    pl_gpu gpu = r->d3d11->gpu;
    for (int i = 0; i < 2; i++) pl_tex_destroy(gpu, &r->planes[i]);
    if (r->sampled) ID3D11Texture2D_Release(r->sampled);
    r->sampled = NULL;
    DXGI_FORMAT luma, chroma;
    if (desc->Format == DXGI_FORMAT_NV12) {
        luma = DXGI_FORMAT_R8_UNORM;
        chroma = DXGI_FORMAT_R8G8_UNORM;
    } else if (desc->Format == DXGI_FORMAT_P010 || desc->Format == DXGI_FORMAT_P016) {
        luma = DXGI_FORMAT_R16_UNORM;
        chroma = DXGI_FORMAT_R16G16_UNORM;
    } else {
        snprintf(r->error, sizeof(r->error), "The graphics card decodes to a format the preview can't show.");
        return 0;
    }
    D3D11_TEXTURE2D_DESC copy = *desc;
    copy.ArraySize = 1;
    copy.MipLevels = 1;
    copy.Usage = D3D11_USAGE_DEFAULT;
    copy.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    copy.CPUAccessFlags = 0;
    copy.MiscFlags = 0;
    if (FAILED(ID3D11Device_CreateTexture2D(r->d3d11->device, &copy, NULL, &r->sampled))) {
        snprintf(r->error, sizeof(r->error), "The graphics card ran out of memory for the preview.");
        return 0;
    }
    r->sampled_desc = *desc;
    int width = (int)desc->Width, height = (int)desc->Height;
    r->planes[0] = pl_d3d11_wrap(gpu, pl_d3d11_wrap_params(
        .tex = (ID3D11Resource *)r->sampled, .fmt = luma, .w = width, .h = height));
    r->planes[1] = pl_d3d11_wrap(gpu, pl_d3d11_wrap_params(
        .tex = (ID3D11Resource *)r->sampled, .fmt = chroma, .w = (width + 1) / 2, .h = (height + 1) / 2));
    if (!r->planes[0] || !r->planes[1]) {
        snprintf(r->error, sizeof(r->error), "The preview could not read the decoded picture.");
        return 0;
    }
    return 1;
}

static int map_hardware(Renderer *r, const DecodedFrame *item, struct pl_frame *image) {
    ID3D11Texture2D *texture = (ID3D11Texture2D *)item->frame->data[0];
    D3D11_TEXTURE2D_DESC desc;
    ID3D11Texture2D_GetDesc(texture, &desc);
    if (!prepare_planes(r, &desc)) return 0;
    ID3D11DeviceContext_CopySubresourceRegion(r->context, (ID3D11Resource *)r->sampled, 0, 0, 0, 0,
                                              (ID3D11Resource *)texture, 0, NULL);
    /* the colour description comes from the decoded frame; only the pixels live in the texture */
    AVFrame meta = *item->frame;
    meta.format = item->sw_format;
    meta.hw_frames_ctx = NULL;
    pl_frame_from_avframe(image, &meta);
    image->planes[0].texture = r->planes[0];
    image->planes[1].texture = r->planes[1];
    return 1;
}

RenderOutcome renderer_draw(Renderer *r, const DecodedFrame *item, const struct pl_custom_lut *lut, double split) {
    int width, height;
    client_size(r->window, &width, &height);
    if (width < 1 || height < 1) return RENDER_DEFERRED;
    pl_gpu gpu = r->d3d11->gpu;
    struct pl_frame image = {0}, target = {0};
    RenderOutcome outcome = RENDER_FAILED;
    EnterCriticalSection(&r->gpu);
    int mapped = item->hardware
                     ? map_hardware(r, item, &image)
                     : pl_map_avframe_ex(gpu, &image, pl_avframe_params(.frame = item->frame, .tex = r->uploads));
    if (!mapped) {
        if (!r->error[0]) snprintf(r->error, sizeof(r->error), "The preview could not upload the decoded picture.");
        goto done;
    }
    if (width != r->width || height != r->height) {
        if (!pl_swapchain_resize(r->swapchain, &width, &height)) {
            snprintf(r->error, sizeof(r->error), "The preview could not change size.");
            goto unmap;
        }
        r->width = width;
        r->height = height;
    }
    struct pl_swapchain_frame swap;
    if (!pl_swapchain_start_frame(r->swapchain, &swap)) {
        outcome = RENDER_DEFERRED;
        goto unmap;
    }
    pl_frame_from_swapchain(&target, &swap);
    float aspect = pl_rect2df_aspect(&image.crop);
    AVRational sar = item->frame->sample_aspect_ratio;
    if (sar.num > 0 && sar.den > 0) aspect *= (float)av_q2d(sar);
    pl_rect2df_aspect_set_rot(&target.crop, aspect, image.rotation - target.rotation, 0);
    int rendered = render_with_lut(r->renderer, &image, &target, lut, split);
    if (!pl_swapchain_submit_frame(r->swapchain)) rendered = 0;
    outcome = rendered ? RENDER_SUBMITTED : RENDER_FAILED;
    if (!rendered) snprintf(r->error, sizeof(r->error), "The preview could not draw the picture.");
unmap:
    if (!item->hardware) pl_unmap_avframe(gpu, &image);
done:
    LeaveCriticalSection(&r->gpu);
    if (outcome != RENDER_SUBMITTED) return outcome;
    HRESULT presented = IDXGISwapChain_Present(r->dxgi, 0, 0);
    if (FAILED(presented)) {
        snprintf(r->error, sizeof(r->error), "The graphics card stopped drawing the preview (0x%08lx).",
                 (unsigned long)presented);
        return RENDER_FAILED;
    }
    /* an occluded or minimized window shows nothing, so nothing counts as presented */
    return presented == S_OK ? RENDER_SUBMITTED : RENDER_DEFERRED;
}

RenderOutcome renderer_clear(Renderer *r) {
    int width, height;
    client_size(r->window, &width, &height);
    if (width < 1 || height < 1) return RENDER_DEFERRED;
    RenderOutcome outcome = RENDER_FAILED;
    EnterCriticalSection(&r->gpu);
    if (width != r->width || height != r->height) {
        if (!pl_swapchain_resize(r->swapchain, &width, &height)) {
            snprintf(r->error, sizeof(r->error), "The preview could not change size.");
            goto done;
        }
        r->width = width;
        r->height = height;
    }
    struct pl_swapchain_frame swap;
    if (!pl_swapchain_start_frame(r->swapchain, &swap)) {
        outcome = RENDER_DEFERRED;
        goto done;
    }
    pl_tex_clear(r->d3d11->gpu, swap.fbo, (float[4]){0, 0, 0, 1});
    if (pl_swapchain_submit_frame(r->swapchain)) outcome = RENDER_SUBMITTED;
    else snprintf(r->error, sizeof(r->error), "The preview could not draw the picture.");
done:
    LeaveCriticalSection(&r->gpu);
    if (outcome != RENDER_SUBMITTED) return outcome;
    HRESULT presented = IDXGISwapChain_Present(r->dxgi, 0, 0);
    if (FAILED(presented)) {
        snprintf(r->error, sizeof(r->error), "The graphics card stopped drawing the preview (0x%08lx).",
                 (unsigned long)presented);
        return RENDER_FAILED;
    }
    return presented == S_OK ? RENDER_SUBMITTED : RENDER_DEFERRED;
}

int renderer_resized(Renderer *r) {
    int width, height;
    client_size(r->window, &width, &height);
    return width > 0 && height > 0 && (width != r->width || height != r->height);
}

double renderer_refresh_interval(Renderer *r) {
    return r->refresh_interval;
}

const char *renderer_error(Renderer *r) {
    return r->error;
}
