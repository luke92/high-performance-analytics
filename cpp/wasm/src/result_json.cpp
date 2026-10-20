#include "result_json.hpp"

#include <cstdio>
#include <optional>

namespace hpa_wasm {
namespace {

void append_number(std::string& out, double v) {
    char buffer[40];
    const int length = std::snprintf(buffer, sizeof buffer, "%.17g", v);
    out.append(buffer, static_cast<std::size_t>(length));
}

void append_optional(std::string& out, const std::optional<double>& v) {
    if (v) append_number(out, *v);
    else out += "null";
}

void append_integer(std::string& out, std::int64_t v) {
    out += std::to_string(v);
}

void append_name(std::string& out, const std::string& name) {
    out += '"';
    out += name;  // validated by the core: [A-Za-z0-9_.-]
    out += '"';
}

}  // namespace

std::string result_to_json(const hpa::AnalyticsResult& r) {
    std::string out;
    out.reserve(1024 + r.histogram.edges.size() * 24);

    out += "{\"summary\":{\"count\":";
    append_integer(out, r.summary.count);
    out += ",\"sum\":";
    append_number(out, r.summary.sum);
    out += ",\"average\":";
    append_optional(out, r.summary.average);
    out += ",\"min\":";
    append_optional(out, r.summary.min);
    out += ",\"max\":";
    append_optional(out, r.summary.max);

    out += "},\"countsByCategoryAndType\":[";
    for (std::size_t i = 0; i < r.counts_by_category_and_type.size(); ++i) {
        const auto& g = r.counts_by_category_and_type[i];
        if (i) out += ',';
        out += "{\"category\":";
        append_name(out, g.category);
        out += ",\"eventType\":";
        append_name(out, g.event_type);
        out += ",\"count\":";
        append_integer(out, g.count);
        out += '}';
    }

    out += "],\"byCategory\":[";
    for (std::size_t i = 0; i < r.by_category.size(); ++i) {
        const auto& c = r.by_category[i];
        if (i) out += ',';
        out += "{\"category\":";
        append_name(out, c.category);
        out += ",\"count\":";
        append_integer(out, c.count);
        out += ",\"sum\":";
        append_number(out, c.sum);
        out += ",\"average\":";
        append_number(out, c.average);
        out += '}';
    }

    out += "],\"histogram\":{\"binCount\":";
    append_integer(out, r.histogram.bin_count);
    out += ",\"min\":";
    append_optional(out, r.histogram.min);
    out += ",\"max\":";
    append_optional(out, r.histogram.max);
    out += ",\"edges\":[";
    for (std::size_t i = 0; i < r.histogram.edges.size(); ++i) {
        if (i) out += ',';
        append_number(out, r.histogram.edges[i]);
    }
    out += "],\"counts\":[";
    for (std::size_t i = 0; i < r.histogram.counts.size(); ++i) {
        if (i) out += ',';
        append_integer(out, r.histogram.counts[i]);
    }

    out += "]},\"percentiles\":{\"p50\":";
    append_optional(out, r.percentiles.p50);
    out += ",\"p95\":";
    append_optional(out, r.percentiles.p95);
    out += ",\"p99\":";
    append_optional(out, r.percentiles.p99);
    out += "}}";
    return out;
}

}  // namespace hpa_wasm
