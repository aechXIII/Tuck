#ifndef TUCK_INPUT_FILE_H
#define TUCK_INPUT_FILE_H

#include <libavformat/avformat.h>

/* avformat_open_input for a file on disk. On Windows FFmpeg reads it through shared_file, so the
   file can be renamed or moved to the Recycle Bin while the player has it open. A format opened
   here is closed with input_file_close, which also frees what the reading needed. */
int input_file_open(AVFormatContext **format, const char *path);
void input_file_close(AVFormatContext **format);

#endif
