#include "marshal.hpp"

#include <cmath>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>

#include "hpa/errors.hpp"
#include "hpa/limits.hpp"
#include "hpa/validate.hpp"

namespace hpa_addon {
namespace {

// Sentinels that every core validator rejects, so the core reports the field itself.
constexpr std::int64_t kInvalidInteger = -1;  // below the minimum of every integer field
constexpr std::int64_t kInvalidBins = 0;      // below the minimum of histogramBins (1)

bool is_plain_object(const Napi::Value& v) {
    return v.Type() == napi_object && !v.IsArray();
}

/// An integral JS number that fits int64 exactly; nullopt for anything else
/// (wrong type, NaN, infinity, fractional, or beyond +-2^63). Never truncates.
std::optional<std::int64_t> integer_of(const Napi::Value& v) {
    if (!v.IsNumber()) return std::nullopt;
    const double d = v.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(d) || d != std::floor(d)) return std::nullopt;
    constexpr double kTwo63 = 9223372036854775808.0;
    if (d >= kTwo63 || d < -kTwo63) return std::nullopt;
    return static_cast<std::int64_t>(d);
}

std::int64_t integer_or(const Napi::Value& v, std::int64_t sentinel) {
    return integer_of(v).value_or(sentinel);
}

Napi::Number num(Napi::Env env, double v) {
    return Napi::Number::New(env, v);
}

Napi::Value optional_num(Napi::Env env, const std::optional<double>& v) {
    return v.has_value() ? static_cast<Napi::Value>(num(env, *v)) : env.Null();
}

/// Writes int64/double vectors as JS numbers (counts are <= 5e6, so exact in a double).
template <typename T>
Napi::Array write_numbers(Napi::Env env, const std::vector<T>& values) {
    Napi::Array out = Napi::Array::New(env, values.size());
    for (std::size_t i = 0; i < values.size(); ++i) {
        out.Set(static_cast<std::uint32_t>(i), num(env, static_cast<double>(values[i])));
    }
    return out;
}

}  // namespace

std::vector<hpa::Event> read_events(const Napi::Value& value) {
    if (!value.IsArray()) throw hpa::ValidationError("events must be an array");
    const Napi::Array array = value.As<Napi::Array>();
    const std::uint32_t length = array.Length();
    if (length > static_cast<std::uint64_t>(hpa::kMaxEvents)) {
        throw hpa::ValidationError("events must contain at most " + std::to_string(hpa::kMaxEvents) + " items");
    }

    const Napi::Env env = value.Env();
    const Napi::String k_id = Napi::String::New(env, "id");
    const Napi::String k_timestamp = Napi::String::New(env, "timestamp");
    const Napi::String k_event_type = Napi::String::New(env, "eventType");
    const Napi::String k_category = Napi::String::New(env, "category");
    const Napi::String k_value = Napi::String::New(env, "value");

    std::vector<hpa::Event> events;
    events.reserve(length);
    for (std::uint32_t i = 0; i < length; ++i) {
        const Napi::Value item = array.Get(i);
        if (!is_plain_object(item)) {
            // Earlier events are validated first, matching the TypeScript order.
            hpa::validate_events(events);
            throw hpa::ValidationError("events[" + std::to_string(i) + "] must be an object");
        }
        const Napi::Object object = item.As<Napi::Object>();

        bool wrong_type = false;
        hpa::Event e;
        const auto take_int = [&](const Napi::Value& v) {
            const auto parsed = integer_of(v);
            wrong_type = wrong_type || !parsed.has_value();
            return parsed.value_or(kInvalidInteger);
        };
        const auto take_string = [&](const Napi::Value& v) {
            wrong_type = wrong_type || !v.IsString();
            return v.IsString() ? v.As<Napi::String>().Utf8Value() : std::string();
        };

        e.id = take_int(object.Get(k_id));
        e.timestamp = take_int(object.Get(k_timestamp));
        e.event_type = take_string(object.Get(k_event_type));
        e.category = take_string(object.Get(k_category));
        const Napi::Value raw_value = object.Get(k_value);
        wrong_type = wrong_type || !raw_value.IsNumber();
        e.value = raw_value.IsNumber() ? raw_value.As<Napi::Number>().DoubleValue()
                                       : std::numeric_limits<double>::quiet_NaN();

        events.push_back(std::move(e));
        if (wrong_type) {
            // The sentinel(s) make the core throw the exact message for the first bad field.
            hpa::validate_events(events);
            throw std::logic_error("hpa addon: sentinel value was accepted by the core validator");
        }
    }
    return events;
}

hpa::GenerateOptions read_generate_options(const Napi::Value& value) {
    if (!is_plain_object(value)) throw hpa::ValidationError("options must be an object");
    const Napi::Object object = value.As<Napi::Object>();

    hpa::GenerateOptions options;
    options.seed = integer_or(object.Get("seed"), kInvalidInteger);
    options.count = integer_or(object.Get("count"), kInvalidInteger);
    // Optional fields: undefined selects the default; any other non-integer is invalid.
    const Napi::Value start = object.Get("startTimestamp");
    if (!start.IsUndefined()) options.start_timestamp = integer_or(start, kInvalidInteger);
    const Napi::Value interval = object.Get("intervalMs");
    if (!interval.IsUndefined()) options.interval_ms = integer_or(interval, kInvalidInteger);
    return options;  // range checks (and their order) are done by hpa::generate_events
}

hpa::ComputeOptions read_compute_options(const Napi::Value& value, bool& options_not_object) {
    options_not_object = false;
    hpa::ComputeOptions options;
    if (value.IsUndefined()) return options;
    if (!is_plain_object(value)) {
        options_not_object = true;
        return options;
    }
    const Napi::Value bins = value.As<Napi::Object>().Get("histogramBins");
    if (!bins.IsUndefined()) options.histogram_bins = integer_or(bins, kInvalidBins);
    return options;
}

Napi::Array write_events(Napi::Env env, const std::vector<hpa::Event>& events) {
    // Key order matches the TypeScript generator so JSON text is identical.
    const Napi::String k_id = Napi::String::New(env, "id");
    const Napi::String k_timestamp = Napi::String::New(env, "timestamp");
    const Napi::String k_event_type = Napi::String::New(env, "eventType");
    const Napi::String k_category = Napi::String::New(env, "category");
    const Napi::String k_value = Napi::String::New(env, "value");

    Napi::Array out = Napi::Array::New(env, events.size());
    for (std::size_t i = 0; i < events.size(); ++i) {
        const hpa::Event& e = events[i];
        Napi::Object o = Napi::Object::New(env);
        o.Set(k_id, num(env, static_cast<double>(e.id)));
        o.Set(k_timestamp, num(env, static_cast<double>(e.timestamp)));
        o.Set(k_event_type, Napi::String::New(env, e.event_type));
        o.Set(k_category, Napi::String::New(env, e.category));
        o.Set(k_value, num(env, e.value));
        out.Set(static_cast<std::uint32_t>(i), o);
    }
    return out;
}

Napi::Object write_result(Napi::Env env, const hpa::AnalyticsResult& r) {
    // Key order matches the TypeScript AnalyticsResult so JSON text is identical.
    Napi::Object summary = Napi::Object::New(env);
    summary.Set("count", num(env, static_cast<double>(r.summary.count)));
    summary.Set("sum", num(env, r.summary.sum));
    summary.Set("average", optional_num(env, r.summary.average));
    summary.Set("min", optional_num(env, r.summary.min));
    summary.Set("max", optional_num(env, r.summary.max));

    Napi::Array counts = Napi::Array::New(env, r.counts_by_category_and_type.size());
    for (std::size_t i = 0; i < r.counts_by_category_and_type.size(); ++i) {
        const auto& g = r.counts_by_category_and_type[i];
        Napi::Object o = Napi::Object::New(env);
        o.Set("category", Napi::String::New(env, g.category));
        o.Set("eventType", Napi::String::New(env, g.event_type));
        o.Set("count", num(env, static_cast<double>(g.count)));
        counts.Set(static_cast<std::uint32_t>(i), o);
    }

    Napi::Array categories = Napi::Array::New(env, r.by_category.size());
    for (std::size_t i = 0; i < r.by_category.size(); ++i) {
        const auto& c = r.by_category[i];
        Napi::Object o = Napi::Object::New(env);
        o.Set("category", Napi::String::New(env, c.category));
        o.Set("count", num(env, static_cast<double>(c.count)));
        o.Set("sum", num(env, c.sum));
        o.Set("average", num(env, c.average));
        categories.Set(static_cast<std::uint32_t>(i), o);
    }

    Napi::Object histogram = Napi::Object::New(env);
    histogram.Set("binCount", num(env, static_cast<double>(r.histogram.bin_count)));
    histogram.Set("min", optional_num(env, r.histogram.min));
    histogram.Set("max", optional_num(env, r.histogram.max));
    histogram.Set("edges", write_numbers(env, r.histogram.edges));
    histogram.Set("counts", write_numbers(env, r.histogram.counts));

    Napi::Object percentiles = Napi::Object::New(env);
    percentiles.Set("p50", optional_num(env, r.percentiles.p50));
    percentiles.Set("p95", optional_num(env, r.percentiles.p95));
    percentiles.Set("p99", optional_num(env, r.percentiles.p99));

    Napi::Object out = Napi::Object::New(env);
    out.Set("summary", summary);
    out.Set("countsByCategoryAndType", counts);
    out.Set("byCategory", categories);
    out.Set("histogram", histogram);
    out.Set("percentiles", percentiles);
    return out;
}

}  // namespace hpa_addon
