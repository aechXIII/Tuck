#include "shared_file.h"

#ifdef _WIN32

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <windows.h>

/* `path` as UTF-16 for the wide Windows calls. A path longer than MAX_PATH works only in the
   \\?\ form, which takes nothing but full paths, the same rule FFmpeg's own reader follows. */
static wchar_t *wide_path(const char *path) {
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
    if (length <= 0) return NULL;
    wchar_t *wide = malloc((size_t)length * sizeof(wchar_t));
    if (!wide) return NULL;
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, length);
    if (length - 1 < MAX_PATH - 12 || wcsncmp(wide, L"\\\\?\\", 4) == 0) return wide;
    DWORD full_length = GetFullPathNameW(wide, 0, NULL, NULL);
    wchar_t *full = full_length ? malloc((size_t)(full_length + 8) * sizeof(wchar_t)) : NULL;
    if (!full || !GetFullPathNameW(wide, full_length, full + 8, NULL)) {
        free(full);
        free(wide);
        return NULL;
    }
    free(wide);
    wchar_t *rest = full + 8;
    if (wcsncmp(rest, L"\\\\", 2) == 0) {
        /* \\server\share becomes \\?\UNC\server\share */
        memcpy(rest - 6, L"\\\\?\\UNC", 7 * sizeof(wchar_t));
        return memmove(full, rest - 6, (wcslen(rest - 6) + 1) * sizeof(wchar_t));
    }
    memcpy(rest - 4, L"\\\\?\\", 4 * sizeof(wchar_t));
    return memmove(full, rest - 4, (wcslen(rest - 4) + 1) * sizeof(wchar_t));
}

void *shared_file_open(const char *path) {
    wchar_t *wide = wide_path(path);
    if (!wide) return NULL;
    HANDLE file = CreateFileW(wide, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    free(wide);
    return file == INVALID_HANDLE_VALUE ? NULL : file;
}

int shared_file_read(void *file, unsigned char *buffer, int size) {
    DWORD read = 0;
    if (size < 0 || !ReadFile(file, buffer, (DWORD)size, &read, NULL)) return -1;
    return (int)read;
}

int64_t shared_file_seek(void *file, int64_t offset, int whence) {
    DWORD method;
    if (whence == SEEK_SET) method = FILE_BEGIN;
    else if (whence == SEEK_CUR) method = FILE_CURRENT;
    else if (whence == SEEK_END) method = FILE_END;
    else return -1;
    LARGE_INTEGER distance = {.QuadPart = offset}, position;
    return SetFilePointerEx(file, distance, &position, method) ? position.QuadPart : -1;
}

int64_t shared_file_size(void *file) {
    LARGE_INTEGER size;
    return GetFileSizeEx(file, &size) ? size.QuadPart : -1;
}

void shared_file_close(void *file) {
    if (file) CloseHandle(file);
}

#else

/* nothing to build: FFmpeg reads files itself outside Windows */
typedef int shared_file_not_needed;

#endif
