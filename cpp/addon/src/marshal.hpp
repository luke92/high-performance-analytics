#pragma once

// JavaScript <-> hpa core conversion for the Node-API addon.
//
// Inputs are converted exactly once. Validation is NOT re-implemented here: when a JS
// value has the wrong type, the field is set to a sentinel the core rejects, so the core
// itself raises the error with the same text and in the same order as the TypeScript
// validators. All functions throw hpa::ValidationError.

#include <napi.h>

#include <vector>

#include "hpa/types.hpp"

namespace hpa_addon {

std::vector<hpa::Event> read_events(const Napi::Value& value);
hpa::GenerateOptions read_generate_options(const Napi::Value& value);

/// `options_not_object` is set when `value` is neither undefined nor a plain object. The
/// caller then raises "options must be an object" after validating the events, which is
/// the order the TypeScript engine uses.
hpa::ComputeOptions read_compute_options(const Napi::Value& value, bool& options_not_object);

Napi::Array write_events(Napi::Env env, const std::vector<hpa::Event>& events);
Napi::Object write_result(Napi::Env env, const hpa::AnalyticsResult& result);

}  // namespace hpa_addon
