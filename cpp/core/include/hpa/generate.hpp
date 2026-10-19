#pragma once

#include <array>
#include <string_view>
#include <vector>

#include "hpa/types.hpp"

namespace hpa {

/// Order is part of the contract: the generator picks by index.
inline constexpr std::array<std::string_view, 5> kCategories = {"books", "clothing", "electronics", "home", "toys"};
inline constexpr std::array<std::string_view, 4> kEventTypes = {"view", "click", "add_to_cart", "purchase"};

/// Deterministic: identical options always yield identical events, and the
/// result equals the TypeScript generateEvents() output. For event i (0-based),
/// one mulberry32 stream draws r1, r2, r3 in order:
///   category   = kCategories[floor(r1 * 5)]
///   event_type = kEventTypes[floor(r2 * 4)]
///   value      = floor(r3 * r3 * 100000) / 100
/// id = i + 1; timestamp = start_timestamp + i * interval_ms.
/// Throws ValidationError for invalid options.
std::vector<Event> generate_events(const GenerateOptions& options);

}  // namespace hpa
