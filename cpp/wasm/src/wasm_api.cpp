// WebAssembly binding for hpa::core (Emscripten). A plain C ABI, no embind.
//
// The module holds NO analytics logic: generation, validation, sorting, aggregation and the histogram
// all come from the unchanged hpa::core. This file only (1) copies the caller's typed-array columns
// into hpa::Event values, (2) calls the core, and (3) hands the result back as UTF-8 text.
//
// Data crosses the boundary in bulk: the caller allocates a few buffers in the WebAssembly heap with
// hpa_alloc, copies whole typed arrays into them, and makes ONE call, so there is no per-event
// boundary cost. Input layout (all arrays have n elements):
//   ids, timestamps, values : double[]    ids/timestamps must be integral (else the core rejects them)
//   event_type_codes, category_codes : uint16[]  indexes into the dictionaries
//   dictionaries: <count>, uint32 lengths[count], concatenated UTF-8 bytes
//
// Results: every call returns a status and leaves one UTF-8 text in an internal buffer
// (hpa_result_ptr/size): the JSON result, or the error message. It stays valid until the next call.
// The module is single-threaded and not re-entrant.
//
// Status codes: 0 ok, 1 validation error (message identical to the TypeScript engine's, except the
// columnar-only messages below), 2 internal error (e.g. out of memory).

#include <emscripten/emscripten.h>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <string>
#include <vector>

#include "hpa/compute.hpp"
#include "hpa/errors.hpp"
#include "hpa/generate.hpp"
#include "hpa/limits.hpp"
#include "hpa/validate.hpp"
#include "result_json.hpp"

#ifndef HPA_CORE_VERSION
#error "HPA_CORE_VERSION must be defined by the build (see cpp/wasm/CMakeLists.txt)"
#endif

namespace {

constexpr int kOk = 0;
constexpr int kValidationError = 1;
constexpr int kInternalError = 2;
constexpr std::int64_t kInvalidInteger = -1;  // below the minimum of every integer field: the core rejects it
constexpr std::uint32_t kMaxDictionary = 65536;

std::string g_result;

struct Generated {
    std::vector<double> ids;
    std::vector<double> timestamps;
    std::vector<double> values;
    std::vector<std::uint16_t> event_type_codes;
    std::vector<std::uint16_t> category_codes;
} g_generated;

/// An integral double that fits int64 exactly, otherwise a value every core validator rejects.
std::int64_t integer_of(double d, bool& exact) {
    constexpr double kTwo63 = 9223372036854775808.0;
    if (!std::isfinite(d) || d != std::floor(d) || d >= kTwo63 || d < -kTwo63) {
        exact = false;
        return kInvalidInteger;
    }
    return static_cast<std::int64_t>(d);
}

std::vector<std::string> read_dictionary(std::uint32_t count, const std::uint32_t* lengths, const std::uint8_t* bytes,
                                         const char* name) {
    if (count > kMaxDictionary) {
        throw hpa::ValidationError(std::string("columns.") + name + " must have at most 65536 entries");
    }
    std::vector<std::string> entries;
    entries.reserve(count);
    std::size_t offset = 0;
    for (std::uint32_t k = 0; k < count; ++k) {
        entries.emplace_back(reinterpret_cast<const char*>(bytes) + offset, lengths[k]);
        offset += lengths[k];
    }
    return entries;
}

template <typename Fn>
int guarded(Fn&& fn) {
    try {
        fn();
        return kOk;
    } catch (const hpa::ValidationError& e) {
        g_result = e.what();
        return kValidationError;
    } catch (const std::exception& e) {
        g_result = e.what();
        return kInternalError;
    }
}

std::string json_string_array(const std::vector<std::string>& values) {
    std::string out = "[";
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (i) out += ',';
        out += '"' + values[i] + '"';  // constants of the core: no escaping needed
    }
    return out + "]";
}

}  // namespace

extern "C" {

/// Version of this C ABI. Bump when a signature or layout changes.
EMSCRIPTEN_KEEPALIVE std::uint32_t hpa_abi_version(void) {
    return 1;
}

EMSCRIPTEN_KEEPALIVE const char* hpa_core_version(void) {
    return HPA_CORE_VERSION;
}

/// sizeof(hpa::Event): the transient C++ memory per event while the core runs.
EMSCRIPTEN_KEEPALIVE std::uint32_t hpa_event_struct_bytes(void) {
    return static_cast<std::uint32_t>(sizeof(hpa::Event));
}

EMSCRIPTEN_KEEPALIVE std::uint32_t hpa_max_events(void) {
    return static_cast<std::uint32_t>(hpa::kMaxEvents);
}

/// 8-byte aligned allocation in the WebAssembly heap; returns 0 on failure. Free with hpa_free.
EMSCRIPTEN_KEEPALIVE void* hpa_alloc(std::uint32_t bytes) {
    return std::malloc(bytes == 0 ? 1 : bytes);
}

EMSCRIPTEN_KEEPALIVE void hpa_free(void* pointer) {
    std::free(pointer);
}

EMSCRIPTEN_KEEPALIVE const char* hpa_result_ptr(void) {
    return g_result.data();
}

EMSCRIPTEN_KEEPALIVE std::uint32_t hpa_result_size(void) {
    return static_cast<std::uint32_t>(g_result.size());
}

/// Computes all analytics over columnar input. `histogram_bins` is only read when `has_histogram_bins`
/// is non-zero; a non-integral value is rejected by the core with the usual message.
EMSCRIPTEN_KEEPALIVE int hpa_compute_columnar(std::uint32_t n, const double* ids, const double* timestamps,
                                              const double* values, const std::uint16_t* event_type_codes,
                                              const std::uint16_t* category_codes, std::uint32_t event_type_count,
                                              const std::uint32_t* event_type_lengths,
                                              const std::uint8_t* event_type_bytes, std::uint32_t category_count,
                                              const std::uint32_t* category_lengths,
                                              const std::uint8_t* category_bytes, double histogram_bins,
                                              int has_histogram_bins) {
    return guarded([&] {
        if (n > static_cast<std::uint64_t>(hpa::kMaxEvents)) {
            throw hpa::ValidationError("events must contain at most " + std::to_string(hpa::kMaxEvents) + " items");
        }
        const std::vector<std::string> event_types =
            read_dictionary(event_type_count, event_type_lengths, event_type_bytes, "eventTypes");
        const std::vector<std::string> categories =
            read_dictionary(category_count, category_lengths, category_bytes, "categories");

        std::vector<hpa::Event> events;
        events.reserve(n);
        for (std::uint32_t i = 0; i < n; ++i) {
            const std::uint16_t type_code = event_type_codes[i];
            const std::uint16_t category_code = category_codes[i];
            if (type_code >= event_types.size() || category_code >= categories.size()) {
                const bool bad_type = type_code >= event_types.size();
                hpa::validate_events(events);  // events before this one are validated first
                throw hpa::ValidationError(
                    std::string("columns.") + (bad_type ? "eventTypeCodes[" : "categoryCodes[") + std::to_string(i) +
                    "] is out of range (dictionary has " +
                    std::to_string(bad_type ? event_types.size() : categories.size()) + " entries)");
            }
            bool exact = true;  // non-integral ids/timestamps become values the core rejects
            hpa::Event e;
            e.id = integer_of(ids[i], exact);
            e.timestamp = integer_of(timestamps[i], exact);
            e.event_type = event_types[type_code];
            e.category = categories[category_code];
            e.value = values[i];
            events.push_back(std::move(e));
        }

        hpa::ComputeOptions options;
        if (has_histogram_bins != 0) {
            bool exact = true;
            const std::int64_t bins = integer_of(histogram_bins, exact);
            options.histogram_bins = exact ? bins : 0;  // 0 is below the minimum: the core reports it
        }
        g_result = hpa_wasm::result_to_json(hpa::compute_analytics(events, options));
    });
}

/// Generates events with hpa::generate_events. On success the JSON result is
/// {"count":N,"eventTypes":[...],"categories":[...]} and the columns are available through the
/// hpa_generated_* pointers until the next call to hpa_generate.
EMSCRIPTEN_KEEPALIVE int hpa_generate(double seed, double count, double start_timestamp, double interval_ms,
                                      int has_start_timestamp, int has_interval_ms) {
    return guarded([&] {
        bool exact = true;
        hpa::GenerateOptions options;
        options.seed = integer_of(seed, exact);
        options.count = integer_of(count, exact);
        if (has_start_timestamp != 0) options.start_timestamp = integer_of(start_timestamp, exact);
        if (has_interval_ms != 0) options.interval_ms = integer_of(interval_ms, exact);

        const std::vector<hpa::Event> events = hpa::generate_events(options);

        std::vector<std::string> type_names;
        for (const auto name : hpa::kEventTypes) type_names.emplace_back(name);
        std::vector<std::string> category_names;
        for (const auto name : hpa::kCategories) category_names.emplace_back(name);

        Generated out;
        const std::size_t n = events.size();
        out.ids.reserve(n);
        out.timestamps.reserve(n);
        out.values.reserve(n);
        out.event_type_codes.reserve(n);
        out.category_codes.reserve(n);
        for (const hpa::Event& e : events) {
            std::uint16_t type_code = 0;
            while (type_names[type_code] != e.event_type) ++type_code;  // generated names always match
            std::uint16_t category_code = 0;
            while (category_names[category_code] != e.category) ++category_code;
            out.ids.push_back(static_cast<double>(e.id));
            out.timestamps.push_back(static_cast<double>(e.timestamp));
            out.values.push_back(e.value);
            out.event_type_codes.push_back(type_code);
            out.category_codes.push_back(category_code);
        }
        g_generated = std::move(out);
        g_result = "{\"count\":" + std::to_string(n) + ",\"eventTypes\":" + json_string_array(type_names) +
                   ",\"categories\":" + json_string_array(category_names) + "}";
    });
}

EMSCRIPTEN_KEEPALIVE const double* hpa_generated_ids(void) {
    return g_generated.ids.data();
}
EMSCRIPTEN_KEEPALIVE const double* hpa_generated_timestamps(void) {
    return g_generated.timestamps.data();
}
EMSCRIPTEN_KEEPALIVE const double* hpa_generated_values(void) {
    return g_generated.values.data();
}
EMSCRIPTEN_KEEPALIVE const std::uint16_t* hpa_generated_event_type_codes(void) {
    return g_generated.event_type_codes.data();
}
EMSCRIPTEN_KEEPALIVE const std::uint16_t* hpa_generated_category_codes(void) {
    return g_generated.category_codes.data();
}

}  // extern "C"
