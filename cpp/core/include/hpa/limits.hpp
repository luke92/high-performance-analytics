#pragma once

#include <cstddef>
#include <cstdint>

// Mirrors apps/api/src/analytics/limits.ts. Keep both in sync.
namespace hpa {

/// Maximum |value|.
inline constexpr double kMaxAbsValue = 1e12;
/// Maximum timestamp: ms since the Unix epoch (the ECMAScript Date range).
inline constexpr std::int64_t kMaxTimestamp = 8'640'000'000'000'000;
/// Maximum id (2^53 - 1, the largest integer a JS number holds exactly).
inline constexpr std::int64_t kMaxId = 9'007'199'254'740'991;
/// Maximum events per dataset.
inline constexpr std::int64_t kMaxEvents = 5'000'000;

inline constexpr std::size_t kMaxStringLength = 64;

inline constexpr std::int64_t kDefaultHistogramBins = 10;
inline constexpr std::int64_t kMaxHistogramBins = 1024;

inline constexpr std::int64_t kMaxUint32 = 4'294'967'295;
inline constexpr std::int64_t kDefaultStartTimestamp = 1'700'000'000'000;
inline constexpr std::int64_t kDefaultIntervalMs = 1000;
inline constexpr std::int64_t kMaxIntervalMs = 86'400'000;

}  // namespace hpa
