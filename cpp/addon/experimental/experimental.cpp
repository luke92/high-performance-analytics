// EXPERIMENTAL Node-API module for the marshalling study (apps/api/bench/marshalling.ts).
// It is never loaded by the API. It reuses the production result writer and option reader
// (src/marshal.*) and the unchanged hpa::core; only the *input* conversion differs:
//
//   computeObjects(events, options?)    same input as the production addon (an array of objects),
//                                       read with fewer Node-API calls: one HandleScope per event and
//                                       one call per field value, strings into a stack buffer.
//   computeColumnar(columns, options?)  columnar typed-array input (see below): no Node-API call per event.
//
// Columnar layout (all columns must have the same length n <= 5,000,000):
//   ids, timestamps, values : Float64Array     (ids/timestamps must be integral; values any double)
//   eventTypeCodes, categoryCodes : Uint16Array  indexes into the dictionaries below
//   eventTypes, categories : string[]          dictionaries, at most 65536 entries each
//
// Validation is still done by the core: non-integral ids/timestamps are replaced with a value the
// core rejects, names are validated per event, so messages equal the object API's for the same data.
// Errors that only exist for this layout (wrong column types, unequal lengths, a code outside its
// dictionary) are reported after the events that precede the offending one have been validated.

#include <napi.h>

#include <cmath>
#include <exception>
#include <limits>
#include <string>
#include <vector>

#include "hpa/compute.hpp"
#include "hpa/errors.hpp"
#include "hpa/limits.hpp"
#include "hpa/validate.hpp"
#include "marshal.hpp"

namespace {

constexpr std::int64_t kInvalidInteger = -1;
constexpr std::size_t kMaxDictionary = 65536;

[[noreturn]] void throw_js_error(Napi::Env env, const std::string& message, const char* code) {
    Napi::Error error = Napi::Error::New(env, message);
    error.Set("code", Napi::String::New(env, code));
    throw error;
}

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

/// Throws the pending JS exception (or a generic Error) for any unexpected Node-API failure.
void check(Napi::Env env, napi_status status) {
    if (status != napi_ok) throw Napi::Error::New(env);
}

/// An integral double that fits int64 exactly; anything else maps to a value every core validator rejects.
/// `exact` is cleared when the input was not representable.
std::int64_t integer_of(double d, bool& exact) {
    constexpr double kTwo63 = 9223372036854775808.0;
    if (!std::isfinite(d) || d != std::floor(d) || d >= kTwo63 || d < -kTwo63) {
        exact = false;
        return kInvalidInteger;
    }
    return static_cast<std::int64_t>(d);
}

// ---- computeObjects: object input, fewer Node-API calls ---------------------------------------

std::int64_t read_integer(Napi::Env env, napi_value object, napi_value key, bool& wrong_type) {
    napi_value v;
    check(env, napi_get_property(env, object, key, &v));
    double d = 0;
    const napi_status s = napi_get_value_double(env, v, &d);
    if (s == napi_number_expected) {
        wrong_type = true;
        return kInvalidInteger;
    }
    check(env, s);
    bool exact = true;
    const std::int64_t result = integer_of(d, exact);
    wrong_type = wrong_type || !exact;
    return result;
}

std::string read_name(Napi::Env env, napi_value object, napi_value key, bool& wrong_type) {
    napi_value v;
    check(env, napi_get_property(env, object, key, &v));
    char buffer[hpa::kMaxStringLength + 2];  // one byte more than allowed, to detect over-long names
    std::size_t length = 0;
    const napi_status s = napi_get_value_string_utf8(env, v, buffer, sizeof buffer, &length);
    if (s == napi_string_expected) {
        wrong_type = true;
        return {};
    }
    check(env, s);
    if (length > hpa::kMaxStringLength) return {};  // rejected by the core with the usual message
    return std::string(buffer, length);
}

std::vector<hpa::Event> read_events_scoped(Napi::Env env, napi_value array) {
    bool is_array = false;
    check(env, napi_is_array(env, array, &is_array));
    if (!is_array) throw hpa::ValidationError("events must be an array");
    std::uint32_t length = 0;
    check(env, napi_get_array_length(env, array, &length));
    if (length > static_cast<std::uint64_t>(hpa::kMaxEvents)) {
        throw hpa::ValidationError("events must contain at most " + std::to_string(hpa::kMaxEvents) + " items");
    }

    napi_value k_id, k_timestamp, k_event_type, k_category, k_value;
    check(env, napi_create_string_utf8(env, "id", NAPI_AUTO_LENGTH, &k_id));
    check(env, napi_create_string_utf8(env, "timestamp", NAPI_AUTO_LENGTH, &k_timestamp));
    check(env, napi_create_string_utf8(env, "eventType", NAPI_AUTO_LENGTH, &k_event_type));
    check(env, napi_create_string_utf8(env, "category", NAPI_AUTO_LENGTH, &k_category));
    check(env, napi_create_string_utf8(env, "value", NAPI_AUTO_LENGTH, &k_value));

    std::vector<hpa::Event> events;
    events.reserve(length);
    for (std::uint32_t i = 0; i < length; ++i) {
        Napi::HandleScope scope(env);  // releases this event's handles instead of accumulating them
        napi_value item;
        check(env, napi_get_element(env, array, i, &item));
        napi_valuetype type;
        check(env, napi_typeof(env, item, &type));
        bool item_is_array = false;
        if (type == napi_object) check(env, napi_is_array(env, item, &item_is_array));
        if (type != napi_object || item_is_array) {
            hpa::validate_events(events);
            throw hpa::ValidationError("events[" + std::to_string(i) + "] must be an object");
        }

        bool wrong_type = false;
        hpa::Event e;
        e.id = read_integer(env, item, k_id, wrong_type);
        e.timestamp = read_integer(env, item, k_timestamp, wrong_type);
        e.event_type = read_name(env, item, k_event_type, wrong_type);
        e.category = read_name(env, item, k_category, wrong_type);
        napi_value value;
        check(env, napi_get_property(env, item, k_value, &value));
        const napi_status s = napi_get_value_double(env, value, &e.value);
        if (s == napi_number_expected) {
            wrong_type = true;
            e.value = std::numeric_limits<double>::quiet_NaN();
        } else {
            check(env, s);
        }

        events.push_back(std::move(e));
        if (wrong_type) {
            hpa::validate_events(events);
            throw std::logic_error("hpa experimental addon: sentinel value was accepted by the core validator");
        }
    }
    return events;
}

Napi::Value ComputeObjects(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    return guarded(env, [&]() -> Napi::Value {
        const std::vector<hpa::Event> events = read_events_scoped(env, info[0]);
        bool options_not_object = false;
        const hpa::ComputeOptions options = hpa_addon::read_compute_options(info[1], options_not_object);
        if (options_not_object) {
            hpa::validate_events(events);
            throw hpa::ValidationError("options must be an object");
        }
        return hpa_addon::write_result(env, hpa::compute_analytics(events, options));
    });
}

// ---- computeColumnar: typed-array input ---------------------------------------------------------

struct Column {
    const void* data = nullptr;
    std::size_t length = 0;
};

Column typed_column(Napi::Env env, napi_value columns, const char* name, napi_typedarray_type expected,
                    const char* type_name) {
    napi_value v;
    check(env, napi_get_named_property(env, columns, name, &v));
    bool is_typed_array = false;
    check(env, napi_is_typedarray(env, v, &is_typed_array));
    napi_typedarray_type type = napi_int8_array;
    std::size_t length = 0;
    void* data = nullptr;
    if (is_typed_array) {
        napi_value buffer;
        std::size_t offset = 0;
        check(env, napi_get_typedarray_info(env, v, &type, &length, &data, &buffer, &offset));
    }
    if (!is_typed_array || type != expected) {
        throw hpa::ValidationError(std::string("columns.") + name + " must be a " + type_name);
    }
    return {data, length};
}

std::vector<std::string> dictionary(Napi::Env env, napi_value columns, const char* name) {
    napi_value v;
    check(env, napi_get_named_property(env, columns, name, &v));
    bool is_array = false;
    check(env, napi_is_array(env, v, &is_array));
    if (!is_array) throw hpa::ValidationError(std::string("columns.") + name + " must be an array of strings");
    const Napi::Array array(env, v);
    if (array.Length() > kMaxDictionary) {
        throw hpa::ValidationError(std::string("columns.") + name + " must have at most 65536 entries");
    }
    std::vector<std::string> entries;
    entries.reserve(array.Length());
    for (std::uint32_t k = 0; k < array.Length(); ++k) {
        const Napi::Value item = array.Get(k);
        if (!item.IsString()) {
            throw hpa::ValidationError(std::string("columns.") + name + "[" + std::to_string(k) + "] must be a string");
        }
        entries.push_back(item.As<Napi::String>().Utf8Value());
    }
    return entries;
}

Napi::Value ComputeColumnar(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    return guarded(env, [&]() -> Napi::Value {
        napi_value columns = info[0];
        napi_valuetype type;
        check(env, napi_typeof(env, columns, &type));
        bool is_array = false;
        if (type == napi_object) check(env, napi_is_array(env, columns, &is_array));
        if (type != napi_object || is_array) throw hpa::ValidationError("columns must be an object");

        const Column ids = typed_column(env, columns, "ids", napi_float64_array, "Float64Array");
        const Column timestamps = typed_column(env, columns, "timestamps", napi_float64_array, "Float64Array");
        const Column values = typed_column(env, columns, "values", napi_float64_array, "Float64Array");
        const Column type_codes = typed_column(env, columns, "eventTypeCodes", napi_uint16_array, "Uint16Array");
        const Column category_codes = typed_column(env, columns, "categoryCodes", napi_uint16_array, "Uint16Array");
        const std::vector<std::string> event_types = dictionary(env, columns, "eventTypes");
        const std::vector<std::string> categories = dictionary(env, columns, "categories");

        const std::size_t n = ids.length;
        if (n > static_cast<std::size_t>(hpa::kMaxEvents)) {
            throw hpa::ValidationError("events must contain at most " + std::to_string(hpa::kMaxEvents) + " items");
        }
        for (const Column* c : {&timestamps, &values, &type_codes, &category_codes}) {
            if (c->length != n) throw hpa::ValidationError("columns must all have the same length");
        }

        const auto* id_data = static_cast<const double*>(ids.data);
        const auto* timestamp_data = static_cast<const double*>(timestamps.data);
        const auto* value_data = static_cast<const double*>(values.data);
        const auto* type_code_data = static_cast<const std::uint16_t*>(type_codes.data);
        const auto* category_code_data = static_cast<const std::uint16_t*>(category_codes.data);

        std::vector<hpa::Event> events;
        events.reserve(n);
        for (std::size_t i = 0; i < n; ++i) {
            const std::uint16_t type_code = type_code_data[i];
            const std::uint16_t category_code = category_code_data[i];
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
            e.id = integer_of(id_data[i], exact);
            e.timestamp = integer_of(timestamp_data[i], exact);
            e.event_type = event_types[type_code];
            e.category = categories[category_code];
            e.value = value_data[i];
            events.push_back(std::move(e));
        }

        bool options_not_object = false;
        const hpa::ComputeOptions options = hpa_addon::read_compute_options(info[1], options_not_object);
        if (options_not_object) {
            hpa::validate_events(events);
            throw hpa::ValidationError("options must be an object");
        }
        return hpa_addon::write_result(env, hpa::compute_analytics(events, options));
    });
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("computeObjects", Napi::Function::New(env, ComputeObjects, "computeObjects"));
    exports.Set("computeColumnar", Napi::Function::New(env, ComputeColumnar, "computeColumnar"));
    exports.Set("eventStructBytes", Napi::Number::New(env, static_cast<double>(sizeof(hpa::Event))));
    exports.Set("coreVersion", Napi::String::New(env, HPA_CORE_VERSION));
    return exports;
}

}  // namespace

NODE_API_MODULE(hpa_addon_experimental, Init)
