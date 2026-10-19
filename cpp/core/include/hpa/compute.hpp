#pragma once

#include <span>

#include "hpa/types.hpp"

namespace hpa {

/// Computes all analytics; validates its input first (ValidationError).
/// Definitions are identical to apps/api/src/analytics/compute.ts:
///
/// Sums: doubles added sequentially in input order from +0.0, no compensation
/// (per category in the order that category's events appear). Average = sum / count.
///
/// Percentiles: nearest-rank, sorted[rank - 1] with rank = max(1, ceil(p * n / 100))
/// in integer arithmetic; ties between -0.0 and +0.0 sort -0.0 first, like
/// Float64Array.prototype.sort. No interpolation. nullopt when n == 0.
///
/// Histogram: bins equal-width bins over the observed [min, max],
/// width = (max - min) / bins; index = min(bins - 1, floor((v - min) / width)),
/// or 0 when width == 0. edges[i] = min + i * width, edges[bins] = max.
///
/// Groups are ordered by category, then event_type (byte order; names are ASCII).
///
/// The build must not enable fast-math or FMA contraction (see CMakeLists.txt),
/// otherwise sums and generated values can differ from TypeScript in the last bit.
AnalyticsResult compute_analytics(std::span<const Event> events, const ComputeOptions& options = {});

}  // namespace hpa
