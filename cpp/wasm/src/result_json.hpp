#pragma once

#include <string>

#include "hpa/types.hpp"

namespace hpa_wasm {

/// Serialises a result as JSON with the same shape and key order as the TypeScript AnalyticsResult.
/// Doubles are printed with 17 significant digits ("%.17g"), which JSON.parse reads back exactly
/// (including "-0"). Absent optionals become null. Category and event type names are guaranteed
/// by the core's validation to need no escaping; this function is not for arbitrary strings.
std::string result_to_json(const hpa::AnalyticsResult& result);

}  // namespace hpa_wasm
