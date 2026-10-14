/* SPDX-License-Identifier: LGPL-2.1-or-later */

#ifndef MIX_INTEGER_H
#define MIX_INTEGER_H

#include <stdint.h>

#if (defined(__i386__) || defined(__x86_64__)) && defined(__GNUC__)
#define MIX_INTEGER_AVX2 1
#include <immintrin.h>
#else
#define MIX_INTEGER_AVX2 0
#endif

/* callers restrict the window to 2..256 eight-bit pictures */
static inline uint8_t mix_pixel_integer(uint8_t *const *src, int count, int x)
{
    unsigned sum = (unsigned)count / 2;
    for (int i = 0; i < count; i++)
        sum += src[i][x];
    return (uint8_t)(sum / (unsigned)count);
}

static void mix_line_integer_c(uint8_t *dst, uint8_t *const *src, int count, int width)
{
    for (int x = 0; x < width; x++)
        dst[x] = mix_pixel_integer(src, count, x);
}

#if MIX_INTEGER_AVX2
__attribute__((target("avx2")))
static void mix_line_integer_avx2(uint8_t *dst, uint8_t *const *src, int count, int width)
{
    const __m256i rounding = _mm256_set1_epi16((short)(count / 2));
    const __m256i reciprocal = _mm256_set1_epi16((short)(65536U / (unsigned)count));
    const __m256i divisor = _mm256_set1_epi16((short)count);
    const __m256i boundary = _mm256_set1_epi16((short)(count - 1));
    int x = 0;

    for (; x + 16 <= width; x += 16) {
        __m256i sum = rounding;
        for (int i = 0; i < count; i++) {
            const __m128i pixels = _mm_loadu_si128((const __m128i *)(src[i] + x));
            sum = _mm256_add_epi16(sum, _mm256_cvtepu8_epi16(pixels));
        }
        /* the truncated reciprocal is at most one quotient short; correct it exactly */
        __m256i quotient = _mm256_mulhi_epu16(sum, reciprocal);
        const __m256i remainder = _mm256_sub_epi16(sum, _mm256_mullo_epi16(quotient, divisor));
        quotient = _mm256_sub_epi16(quotient, _mm256_cmpgt_epi16(remainder, boundary));
        const __m128i pixels = _mm_packus_epi16(
            _mm256_castsi256_si128(quotient), _mm256_extracti128_si256(quotient, 1));
        _mm_storeu_si128((__m128i *)(dst + x), pixels);
    }
    for (; x < width; x++)
        dst[x] = mix_pixel_integer(src, count, x);
}
#endif

#endif
