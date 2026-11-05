#include "input_file.h"

#ifdef _WIN32

#include <errno.h>
#include <stdio.h>

#include <libavutil/error.h>
#include <libavutil/mem.h>

#include "shared_file.h"

/* the same size FFmpeg's own file reader uses */
#define READ_SIZE (64 * 1024)

static int read_packet(void *file, uint8_t *buffer, int size) {
    int read = shared_file_read(file, buffer, size);
    if (read < 0) return AVERROR(EIO);
    return read ? read : AVERROR_EOF;
}

static int64_t seek(void *file, int64_t offset, int whence) {
    if (whence & AVSEEK_SIZE) {
        int64_t size = shared_file_size(file);
        return size < 0 ? AVERROR(EIO) : size;
    }
    int64_t position = shared_file_seek(file, offset, whence & ~AVSEEK_FORCE);
    return position < 0 ? AVERROR(EIO) : position;
}

static void free_reading(AVIOContext **io) {
    if (!*io) return;
    void *file = (*io)->opaque;
    av_freep(&(*io)->buffer);
    avio_context_free(io);
    shared_file_close(file);
}

int input_file_open(AVFormatContext **format, const char *path) {
    void *file = shared_file_open(path);
    if (!file) return AVERROR(ENOENT);
    unsigned char *buffer = av_malloc(READ_SIZE);
    AVIOContext *io = buffer ? avio_alloc_context(buffer, READ_SIZE, 0, file, read_packet, NULL, seek) : NULL;
    if (!io) {
        av_free(buffer);
        shared_file_close(file);
        return AVERROR(ENOMEM);
    }
    if (!*format && !(*format = avformat_alloc_context())) {
        free_reading(&io);
        return AVERROR(ENOMEM);
    }
    (*format)->pb = io;
    int result = avformat_open_input(format, path, NULL, NULL);
    /* a failed open frees the format but leaves reading set up by its caller alone */
    if (result < 0) free_reading(&io);
    return result;
}

void input_file_close(AVFormatContext **format) {
    AVIOContext *io = *format && ((*format)->flags & AVFMT_FLAG_CUSTOM_IO) ? (*format)->pb : NULL;
    avformat_close_input(format);
    free_reading(&io);
}

#else

int input_file_open(AVFormatContext **format, const char *path) {
    return avformat_open_input(format, path, NULL, NULL);
}

void input_file_close(AVFormatContext **format) {
    avformat_close_input(format);
}

#endif
