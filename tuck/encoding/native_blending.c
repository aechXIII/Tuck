#include <stddef.h>
#include <stdint.h>

#ifdef _WIN32
#define TUCK_EXPORT __declspec(dllexport)
#else
#define TUCK_EXPORT __attribute__((visibility("default")))
#endif

#if (defined(__i386__) || defined(__x86_64__)) && defined(__GNUC__)
#define TUCK_AVX2 1
#include <immintrin.h>
#else
#define TUCK_AVX2 0
#endif

TUCK_EXPORT unsigned tuck_blending_abi(void)
{
    return 1;
}

static void blend_encoded_c(uint8_t *out, const uint8_t *const *pictures,
                            const uint32_t *weights, size_t length, uint32_t count)
{
    for (size_t x = 0; x < length; x++) {
        uint32_t sum = 32768;
        for (uint32_t i = 0; i < count; i++)
            if (weights[i])
                sum += (uint32_t)pictures[i][x] * weights[i];
        out[x] = (uint8_t)(sum >> 16);
    }
}

static void accumulate_linear_c(float *out, const uint8_t *const *pictures,
                                const float *weights, const float *lookup,
                                size_t length, uint32_t count)
{
    for (size_t x = 0; x < length; x++) {
        float sum = 0.f;
        for (uint32_t i = 0; i < count; i++) {
            /* builds disable contraction so NumPy's product rounding stays separate */
            const float product = lookup[pictures[i][x]] * weights[i];
            sum = sum + product;
        }
        out[x] = sum;
    }
}

#if TUCK_AVX2
__attribute__((target("avx2")))
static void blend_encoded_avx2(uint8_t *out, const uint8_t *const *pictures,
                               const uint32_t *weights, size_t length, uint32_t count)
{
    size_t x = 0;
    for (; length - x >= 8; x += 8) {
        __m256i sum = _mm256_set1_epi32(32768);
        for (uint32_t i = 0; i < count; i++) {
            if (!weights[i])
                continue;
            const __m128i bytes = _mm_loadl_epi64((const __m128i *)(pictures[i] + x));
            const __m256i pixels = _mm256_cvtepu8_epi32(bytes);
            const __m256i weight = _mm256_set1_epi32((int)weights[i]);
            sum = _mm256_add_epi32(sum, _mm256_mullo_epi32(pixels, weight));
        }
        sum = _mm256_srli_epi32(sum, 16);
        const __m128i words = _mm_packus_epi32(
            _mm256_castsi256_si128(sum), _mm256_extracti128_si256(sum, 1));
        _mm_storel_epi64((__m128i *)(out + x), _mm_packus_epi16(words, words));
    }
    for (; x < length; x++) {
        uint32_t sum = 32768;
        for (uint32_t i = 0; i < count; i++)
            if (weights[i])
                sum += (uint32_t)pictures[i][x] * weights[i];
        out[x] = (uint8_t)(sum >> 16);
    }
}

__attribute__((target("avx2")))
static void accumulate_linear_avx2(float *out, const uint8_t *const *pictures,
                                   const float *weights, const float *lookup,
                                   size_t length, uint32_t count)
{
    size_t x = 0;
    for (; length - x >= 8; x += 8) {
        __m256 sum = _mm256_setzero_ps();
        for (uint32_t i = 0; i < count; i++) {
            const __m128i bytes = _mm_loadl_epi64((const __m128i *)(pictures[i] + x));
            const __m256i indices = _mm256_cvtepu8_epi32(bytes);
            const __m256 values = _mm256_i32gather_ps(lookup, indices, 4);
            const __m256 product = _mm256_mul_ps(values, _mm256_set1_ps(weights[i]));
            sum = _mm256_add_ps(sum, product);
        }
        _mm256_storeu_ps(out + x, sum);
    }
    for (; x < length; x++) {
        float sum = 0.f;
        for (uint32_t i = 0; i < count; i++) {
            const float product = lookup[pictures[i][x]] * weights[i];
            sum = sum + product;
        }
        out[x] = sum;
    }
}
#endif

TUCK_EXPORT int tuck_blend_encoded(uint8_t *out, const uint8_t *const *pictures,
                                  const uint32_t *weights, size_t length,
                                  uint32_t count, int use_simd)
{
    if (!out || !pictures || !weights || count < 1 || count > 256 || !length)
        return -1;
#if TUCK_AVX2
    if (use_simd && __builtin_cpu_supports("avx2")) {
        blend_encoded_avx2(out, pictures, weights, length, count);
        return 0;
    }
#else
    (void)use_simd;
#endif
    blend_encoded_c(out, pictures, weights, length, count);
    return 0;
}

TUCK_EXPORT int tuck_accumulate_linear(float *out, const uint8_t *const *pictures,
                                      const float *weights, const float *lookup,
                                      size_t length, uint32_t count, int use_simd)
{
    if (!out || !pictures || !weights || !lookup || count < 1 || count > 256 || !length)
        return -1;
#if TUCK_AVX2
    if (use_simd && __builtin_cpu_supports("avx2")) {
        accumulate_linear_avx2(out, pictures, weights, lookup, length, count);
        return 0;
    }
#else
    (void)use_simd;
#endif
    accumulate_linear_c(out, pictures, weights, lookup, length, count);
    return 0;
}
