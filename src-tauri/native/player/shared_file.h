#ifndef TUCK_SHARED_FILE_H
#define TUCK_SHARED_FILE_H

/* A file opened for reading that can still be renamed, moved to the Recycle Bin or deleted while
   it is open, by Tuck or by any other program, as on Linux. FFmpeg's own reader on Windows opens
   files without that, so the video in the preview couldn't be renamed or moved. Windows only:
   elsewhere FFmpeg reads files itself. */

#ifdef _WIN32

#include <stdint.h>

/* the open file, or NULL when it can't be opened; `path` is UTF-8 */
void *shared_file_open(const char *path);
/* the number of bytes read, 0 at the end of the file, or -1 on an error */
int shared_file_read(void *file, unsigned char *buffer, int size);
/* the new position, or -1; `whence` is SEEK_SET, SEEK_CUR or SEEK_END */
int64_t shared_file_seek(void *file, int64_t offset, int whence);
/* the file's size in bytes, or -1 */
int64_t shared_file_size(void *file);
void shared_file_close(void *file);

#endif

#endif
