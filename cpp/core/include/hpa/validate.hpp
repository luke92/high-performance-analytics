#pragma once

#include <span>

#include "hpa/types.hpp"

namespace hpa {

// Each function throws ValidationError on the first violation, checking fields
// in the same order as the TypeScript validators so messages are identical.

/// Count limit first, then per event: id, timestamp, eventType, category, value.
void validate_events(std::span<const Event> events);
/// seed, count, startTimestamp, intervalMs, then the last-timestamp range check.
void validate_generate_options(const GenerateOptions& options);
void validate_compute_options(const ComputeOptions& options);

}  // namespace hpa
