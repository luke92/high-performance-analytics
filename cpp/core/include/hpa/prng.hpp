#pragma once

#include <cstdint>

namespace hpa {

/// mulberry32, bit-for-bit equivalent to apps/api/src/analytics/prng.ts.
/// All arithmetic is unsigned 32-bit and wraps modulo 2^32 (JS Math.imul and
/// ToInt32 produce the same low 32 bits). next() returns uint32 / 2^32 in [0, 1).
class Mulberry32 {
public:
    explicit constexpr Mulberry32(std::uint32_t seed) noexcept : state_(seed) {}

    constexpr double next() noexcept {
        state_ += 0x6d2b79f5U;
        std::uint32_t t = state_;
        t = (t ^ (t >> 15)) * (t | 1U);
        t ^= t + (t ^ (t >> 7)) * (t | 61U);
        return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
    }

private:
    std::uint32_t state_;
};

}  // namespace hpa
