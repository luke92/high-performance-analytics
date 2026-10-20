#include <napi.h>

#include <exception>
#include <string>

#include "hpa/compute.hpp"
#include "hpa/errors.hpp"
#include "hpa/generate.hpp"
#include "hpa/validate.hpp"
#include "marshal.hpp"

#ifndef HPA_CORE_VERSION
#error "HPA_CORE_VERSION must be defined by the build (see cpp/addon/CMakeLists.txt)"
#endif

namespace {

[[noreturn]] void throw_js_error(Napi::Env env, const std::string& message, const char* code) {
    Napi::Error error = Napi::Error::New(env, message);
    error.Set("code", Napi::String::New(env, code));
    throw error;
}

/// Runs `fn`, translating C++ exceptions into JS errors with a stable `code`:
///   HPA_VALIDATION_ERROR  invalid input (the API maps it to HTTP 400)
///   HPA_INTERNAL_ERROR    anything unexpected
/// Napi::Error (a pending JS exception, e.g. from a throwing getter) passes through untouched.
template <typename Fn>
Napi::Value guarded(Napi::Env env, Fn&& fn) {
    try {
        return fn();
    } catch (const hpa::ValidationError& e) {
        throw_js_error(env, e.what(), "HPA_VALIDATION_ERROR");
    } catch (const Napi::Error&) {
        throw;
    } catch (const std::exception& e) {
        throw_js_error(env, e.what(), "HPA_INTERNAL_ERROR");
    }
}

// generateEvents(options: { seed, count, startTimestamp?, intervalMs? }): AnalyticsEvent[]
Napi::Value GenerateEvents(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    return guarded(env, [&]() -> Napi::Value {
        const hpa::GenerateOptions options = hpa_addon::read_generate_options(info[0]);
        return hpa_addon::write_events(env, hpa::generate_events(options));
    });
}

// computeAnalytics(events: AnalyticsEvent[], options?: { histogramBins? }): AnalyticsResult
Napi::Value ComputeAnalytics(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    return guarded(env, [&]() -> Napi::Value {
        const std::vector<hpa::Event> events = hpa_addon::read_events(info[0]);
        bool options_not_object = false;
        const hpa::ComputeOptions options = hpa_addon::read_compute_options(info[1], options_not_object);
        if (options_not_object) {
            hpa::validate_events(events);  // events are validated first, like the TypeScript engine
            throw hpa::ValidationError("options must be an object");
        }
        return hpa_addon::write_result(env, hpa::compute_analytics(events, options));
    });
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("generateEvents", Napi::Function::New(env, GenerateEvents, "generateEvents"));
    exports.Set("computeAnalytics", Napi::Function::New(env, ComputeAnalytics, "computeAnalytics"));
    exports.Set("coreVersion", Napi::String::New(env, HPA_CORE_VERSION));
    exports.Set("napiVersion", Napi::Number::New(env, NAPI_VERSION));
    return exports;
}

}  // namespace

NODE_API_MODULE(hpa_addon, Init)
