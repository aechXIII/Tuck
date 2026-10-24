/* Sound on Windows through a shared-mode WASAPI stream. Windows converts the 48 kHz float stream
   to the device's own format. A render thread owns every COM object (COM is initialized there)
   and does all device calls; the other threads only queue sound and ask for changes, which the
   render thread applies before acknowledging them. The device's clock reports what has been
   played, and between its reports the position runs on for at most one device period. */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include "audio_output.h"

#include <windows.h>

#include <audioclient.h>
#include <math.h>
#include <mmdeviceapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "playback_state.h"

/* documented in audiosessiontypes.h, missing from the MinGW headers on the Ubuntu 22.04 build */
#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

/* the shared-mode buffer asked for: 40 ms, well inside the 100 ms the queue primes */
#define BUFFER_HNS 400000
/* a change not applied within this long means the render thread is stuck */
#define APPLY_TIMEOUT_MS 2000

static const CLSID enumerator_class = {0xbcde0395, 0xe52f, 0x467c, {0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e}};
static const IID enumerator_id = {0xa95664d2, 0x9614, 0x4f35, {0xa7, 0x46, 0xde, 0x8d, 0xb6, 0x36, 0x17, 0xe6}};
static const IID client_id = {0x1cb9ad4c, 0xdbfa, 0x4c32, {0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2}};
static const IID render_id = {0xf294acfc, 0x3146, 0x4483, {0xa7, 0xbf, 0xad, 0xdc, 0xa7, 0xc2, 0x60, 0xe2}};
static const IID clock_id = {0xcd63314f, 0x3fba, 0x4a1b, {0x81, 0x2c, 0xef, 0x96, 0x35, 0x87, 0x28, 0xe7}};

struct AudioOutput {
    CRITICAL_SECTION lock;
    HANDLE thread, wake, ready, applied;
    volatile LONG stop;
    /* under lock */
    PcmQueue pcm;
    float gain;
    int paused, finished;
    int reset;
    uint64_t reset_generation;
    uint64_t command, acknowledged;
    int running;
    /* the device's last report: seconds played of this generation, and when (QPC seconds) */
    double played, played_at, period;
    uint64_t underruns;
    char error[160];
};

static double qpc_seconds(void) {
    static LARGE_INTEGER frequency;
    LARGE_INTEGER counter;
    if (!frequency.QuadPart) QueryPerformanceFrequency(&frequency);
    QueryPerformanceCounter(&counter);
    return (double)counter.QuadPart / (double)frequency.QuadPart;
}

/* under lock */
static void set_error(AudioOutput *o, const char *step, HRESULT result) {
    if (!o->error[0])
        snprintf(o->error, sizeof(o->error), "The sound device failed while %s (0x%08lx).", step,
                 (unsigned long)result);
}

typedef struct Device {
    IMMDeviceEnumerator *enumerator;
    IMMDevice *device;
    IAudioClient *client;
    IAudioRenderClient *render;
    IAudioClock *clock;
    HANDLE event;
    UINT32 size;
    UINT64 frequency;
} Device;

static void release_device(Device *d) {
    if (d->client) IAudioClient_Stop(d->client);
    if (d->clock) IAudioClock_Release(d->clock);
    if (d->render) IAudioRenderClient_Release(d->render);
    if (d->client) IAudioClient_Release(d->client);
    if (d->device) IMMDevice_Release(d->device);
    if (d->enumerator) IMMDeviceEnumerator_Release(d->enumerator);
    if (d->event) CloseHandle(d->event);
}

/* with COM initialized on this thread; the failing step on failure */
static const char *open_device(Device *d, HRESULT *result, REFERENCE_TIME *period) {
    WAVEFORMATEX format = {
        .wFormatTag = WAVE_FORMAT_IEEE_FLOAT,
        .nChannels = 2,
        .nSamplesPerSec = 48000,
        .nAvgBytesPerSec = 48000 * 2 * sizeof(float),
        .nBlockAlign = 2 * sizeof(float),
        .wBitsPerSample = 32,
    };
    d->event = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!d->event) {
        *result = E_OUTOFMEMORY;
        return "starting";
    }
    *result = CoCreateInstance(&enumerator_class, NULL, CLSCTX_ALL, &enumerator_id, (void **)&d->enumerator);
    if (FAILED(*result)) return "looking for speakers";
    *result = IMMDeviceEnumerator_GetDefaultAudioEndpoint(d->enumerator, eRender, eConsole, &d->device);
    if (FAILED(*result)) return "looking for speakers";
    *result = IMMDevice_Activate(d->device, &client_id, CLSCTX_ALL, NULL, (void **)&d->client);
    if (FAILED(*result)) return "opening the speakers";
    *result = IAudioClient_Initialize(d->client, AUDCLNT_SHAREMODE_SHARED,
                                      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY |
                                          AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                      BUFFER_HNS, 0, &format, NULL);
    if (FAILED(*result)) return "setting up the sound format";
    *result = IAudioClient_SetEventHandle(d->client, d->event);
    if (FAILED(*result)) return "setting up the sound format";
    *result = IAudioClient_GetBufferSize(d->client, &d->size);
    if (FAILED(*result)) return "setting up the sound format";
    if (d->size > PCM_PRIME_FRAMES) {
        *result = E_NOTIMPL;
        return "setting up a short enough sound buffer";
    }
    *result = IAudioClient_GetService(d->client, &render_id, (void **)&d->render);
    if (FAILED(*result)) return "setting up the sound format";
    *result = IAudioClient_GetService(d->client, &clock_id, (void **)&d->clock);
    if (FAILED(*result)) return "reading the sound clock";
    *result = IAudioClock_GetFrequency(d->clock, &d->frequency);
    if (FAILED(*result) || !d->frequency) return "reading the sound clock";
    *result = IAudioClient_GetDevicePeriod(d->client, period, NULL);
    if (FAILED(*result)) return "reading the sound clock";
    return NULL;
}

/* under lock: applies pause and reset; the failing step on failure */
static const char *apply_changes(AudioOutput *o, Device *d, HRESULT *result) {
    if ((o->reset || o->paused) && o->running) {
        *result = IAudioClient_Stop(d->client);
        if (FAILED(*result)) return "pausing";
        o->running = 0;
    }
    if (o->reset) {
        /* drops what the device still holds and starts its position over */
        *result = IAudioClient_Reset(d->client);
        if (FAILED(*result)) return "moving to a new position";
        pcm_reset(&o->pcm, o->reset_generation);
        o->finished = 0;
        o->played = 0;
        o->played_at = qpc_seconds();
        o->reset = 0;
    }
    return NULL;
}

/* under lock: tops the device buffer up from the queue; the failing step on failure */
static const char *feed(AudioOutput *o, Device *d, HRESULT *result) {
    UINT32 padding = 0;
    *result = IAudioClient_GetCurrentPadding(d->client, &padding);
    if (FAILED(*result)) return "playing";
    UINT32 room = d->size - padding;
    int primed = o->pcm.count >= PCM_PRIME_FRAMES || (o->finished && o->pcm.count);
    if (o->paused) return NULL;
    /* after a pause the device still holds sound and may have no room at all, but it must start
       again; a fresh generation waits until the queue is primed */
    if (!o->running && !primed && !padding) return NULL;
    if (room) {
        BYTE *buffer = NULL;
        *result = IAudioRenderClient_GetBuffer(d->render, room, &buffer);
        if (FAILED(*result)) return "playing";
        float *samples = (float *)buffer;
        size_t got = pcm_read(&o->pcm, samples, room);
        for (size_t i = 0; i < got * 2; i++) samples[i] *= o->gain;
        if (got < room) {
            memset(samples + got * 2, 0, (room - got) * 2 * sizeof(float));
            /* the end of a finished generation is not a gap */
            if (!o->finished) {
                pcm_note_underrun(&o->pcm, room - got);
                o->underruns++;
            }
        }
        *result = IAudioRenderClient_ReleaseBuffer(d->render, room, 0);
        if (FAILED(*result)) return "playing";
    }
    if (!o->running) {
        *result = IAudioClient_Start(d->client);
        if (FAILED(*result)) return "starting to play";
        o->running = 1;
        /* the position runs on from here, not from the report before the pause */
        o->played_at = qpc_seconds();
    }
    return NULL;
}

/* under lock: what the device says it has played */
static const char *read_position(AudioOutput *o, Device *d, HRESULT *result) {
    UINT64 position = 0, qpc = 0;
    *result = IAudioClock_GetPosition(d->clock, &position, &qpc);
    if (FAILED(*result)) return "reading the sound clock";
    double played = (double)position / (double)d->frequency;
    /* QPC time in 100 ns units */
    double at = (double)qpc / 1e7;
    if (played >= o->played) {
        o->played = played;
        o->played_at = at;
    }
    return NULL;
}

static DWORD WINAPI render_main(void *opaque) {
    AudioOutput *o = opaque;
    Device d = {0};
    REFERENCE_TIME period = 0;
    HRESULT result = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    int com = SUCCEEDED(result);
    const char *step = com ? open_device(&d, &result, &period) : "starting";
    EnterCriticalSection(&o->lock);
    if (step) set_error(o, step, result);
    o->period = period / 1e7;
    LeaveCriticalSection(&o->lock);
    SetEvent(o->ready);
    while (!step && !InterlockedCompareExchange(&o->stop, 0, 0)) {
        EnterCriticalSection(&o->lock);
        step = apply_changes(o, &d, &result);
        if (!step) step = feed(o, &d, &result);
        if (!step) step = read_position(o, &d, &result);
        if (step) set_error(o, step, result);
        o->acknowledged = o->command;
        LeaveCriticalSection(&o->lock);
        SetEvent(o->applied);
        HANDLE events[] = {o->wake, d.event};
        if (!step) WaitForMultipleObjects(2, events, FALSE, INFINITE);
    }
    EnterCriticalSection(&o->lock);
    o->running = 0;
    LeaveCriticalSection(&o->lock);
    SetEvent(o->applied);
    release_device(&d);
    if (com) CoUninitialize();
    return 0;
}

AudioOutput *audio_output_open(char *error, size_t error_size) {
    AudioOutput *o = calloc(1, sizeof(*o));
    if (!o) {
        snprintf(error, error_size, "Out of memory while opening the sound device.");
        return NULL;
    }
    InitializeCriticalSection(&o->lock);
    o->gain = 1;
    o->paused = 1;
    o->wake = CreateEventW(NULL, FALSE, FALSE, NULL);
    o->ready = CreateEventW(NULL, TRUE, FALSE, NULL);
    o->applied = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (o->wake && o->ready && o->applied) o->thread = CreateThread(NULL, 0, render_main, o, 0, NULL);
    if (!o->thread || WaitForSingleObject(o->ready, 5000) != WAIT_OBJECT_0 || o->error[0]) {
        snprintf(error, error_size, "%s", o->error[0] ? o->error : "The sound device did not answer.");
        audio_output_close(o);
        return NULL;
    }
    return o;
}

void audio_output_close(AudioOutput *o) {
    if (!o) return;
    InterlockedExchange(&o->stop, 1);
    if (o->wake) SetEvent(o->wake);
    if (o->thread) {
        WaitForSingleObject(o->thread, INFINITE);
        CloseHandle(o->thread);
    }
    if (o->wake) CloseHandle(o->wake);
    if (o->ready) CloseHandle(o->ready);
    if (o->applied) CloseHandle(o->applied);
    DeleteCriticalSection(&o->lock);
    free(o);
}

/* asks the render thread to apply what was just changed and waits until it has */
static void apply(AudioOutput *o) {
    EnterCriticalSection(&o->lock);
    uint64_t command = ++o->command;
    LeaveCriticalSection(&o->lock);
    SetEvent(o->wake);
    for (;;) {
        EnterCriticalSection(&o->lock);
        int done = o->acknowledged >= command || o->error[0];
        LeaveCriticalSection(&o->lock);
        if (done) return;
        if (WaitForSingleObject(o->applied, APPLY_TIMEOUT_MS) != WAIT_OBJECT_0) {
            EnterCriticalSection(&o->lock);
            set_error(o, "answering", HRESULT_FROM_WIN32(ERROR_TIMEOUT));
            LeaveCriticalSection(&o->lock);
            return;
        }
    }
}

size_t audio_output_write(AudioOutput *o, const float *samples, size_t frames, uint64_t generation) {
    EnterCriticalSection(&o->lock);
    size_t written = o->error[0] ? 0 : pcm_write(&o->pcm, samples, frames, generation);
    LeaveCriticalSection(&o->lock);
    if (written) SetEvent(o->wake);
    return written;
}

void audio_output_finish(AudioOutput *o, uint64_t generation) {
    EnterCriticalSection(&o->lock);
    if (generation == o->pcm.generation) o->finished = 1;
    LeaveCriticalSection(&o->lock);
    SetEvent(o->wake);
}

void audio_output_reset(AudioOutput *o, uint64_t generation) {
    EnterCriticalSection(&o->lock);
    o->paused = 1;
    o->reset = 1;
    o->reset_generation = generation;
    /* the queue takes only the new generation from now on, even before the device has reset, and
       what the old one played must not count for the new one in a status read before then */
    pcm_reset(&o->pcm, generation);
    o->played = 0;
    o->played_at = qpc_seconds();
    LeaveCriticalSection(&o->lock);
    apply(o);
}

void audio_output_pause(AudioOutput *o, int paused) {
    EnterCriticalSection(&o->lock);
    o->paused = paused != 0;
    LeaveCriticalSection(&o->lock);
    apply(o);
}

void audio_output_volume(AudioOutput *o, float gain) {
    if (!isfinite(gain)) return;
    EnterCriticalSection(&o->lock);
    o->gain = fminf(1, fmaxf(0, gain));
    LeaveCriticalSection(&o->lock);
}

int audio_output_failed(AudioOutput *o) {
    EnterCriticalSection(&o->lock);
    int failed = o->error[0] != 0;
    LeaveCriticalSection(&o->lock);
    return failed;
}

void audio_output_status(AudioOutput *o, AudioOutputStatus *status) {
    EnterCriticalSection(&o->lock);
    double played = o->played;
    /* between the device's reports the position runs on, but never more than one period */
    if (o->running && !o->paused) played += fmin(fmax(qpc_seconds() - o->played_at, 0), o->period);
    status->generation = o->pcm.generation;
    status->played = played;
    status->underruns = o->underruns;
    status->failed = o->error[0] != 0;
    snprintf(status->error, sizeof(status->error), "%s", o->error);
    LeaveCriticalSection(&o->lock);
}
