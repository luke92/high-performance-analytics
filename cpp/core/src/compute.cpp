#include "hpa/compute.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <map>
#include <string>

#include "hpa/validate.hpp"

namespace hpa {
namespace {

struct CategoryAggregate {
    std::int64_t count = 0;
    double sum = 0.0;
    std::map<std::string, std::int64_t, std::less<>> by_type;
};

/// Ascending order that places -0.0 before +0.0, matching Float64Array.prototype.sort.
bool total_less(double a, double b) noexcept {
    if (a < b) return true;
    if (a > b) return false;
    return std::signbit(a) && !std::signbit(b);
}

double nearest_rank(const std::vector<double>& sorted, std::int64_t p) {
    const auto n = static_cast<std::int64_t>(sorted.size());
    const std::int64_t rank = std::max<std::int64_t>(1, (p * n + 99) / 100);  // integer ceil(p * n / 100)
    return sorted[static_cast<std::size_t>(rank - 1)];
}

Histogram build_histogram(const std::vector<double>& values, std::int64_t bins, double min, double max) {
    Histogram h;
    h.bin_count = bins;
    h.counts.assign(static_cast<std::size_t>(bins), 0);
    if (values.empty()) return h;

    const double width = (max - min) / static_cast<double>(bins);
    for (const double v : values) {
        std::int64_t index = 0;
        if (width != 0.0) {
            index = std::min<std::int64_t>(bins - 1, static_cast<std::int64_t>(std::floor((v - min) / width)));
        }
        ++h.counts[static_cast<std::size_t>(index)];
    }
    h.edges.resize(static_cast<std::size_t>(bins) + 1);
    for (std::int64_t i = 0; i < bins; ++i) h.edges[static_cast<std::size_t>(i)] = min + static_cast<double>(i) * width;
    h.edges[static_cast<std::size_t>(bins)] = max;
    h.min = min;
    h.max = max;
    return h;
}

}  // namespace

AnalyticsResult compute_analytics(std::span<const Event> events, const ComputeOptions& options) {
    validate_events(events);
    validate_compute_options(options);

    const std::size_t n = events.size();
    std::vector<double> values;
    values.reserve(n);
    std::map<std::string, CategoryAggregate, std::less<>> categories;
    double sum = 0.0;
    double min = std::numeric_limits<double>::infinity();
    double max = -std::numeric_limits<double>::infinity();

    for (const Event& e : events) {
        const double v = e.value;
        values.push_back(v);
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;

        auto it = categories.find(e.category);
        if (it == categories.end()) it = categories.emplace(e.category, CategoryAggregate{}).first;
        CategoryAggregate& agg = it->second;
        ++agg.count;
        agg.sum += v;
        ++agg.by_type[e.event_type];
    }

    AnalyticsResult result;
    result.summary.count = static_cast<std::int64_t>(n);
    result.summary.sum = sum;
    if (n > 0) {
        result.summary.average = sum / static_cast<double>(n);
        result.summary.min = min;
        result.summary.max = max;
    }

    for (const auto& [category, agg] : categories) {
        result.by_category.push_back({category, agg.count, agg.sum, agg.sum / static_cast<double>(agg.count)});
        for (const auto& [event_type, count] : agg.by_type) {
            result.counts_by_category_and_type.push_back({category, event_type, count});
        }
    }

    result.histogram = build_histogram(values, options.histogram_bins, min, max);

    if (n > 0) {
        std::sort(values.begin(), values.end(), total_less);
        result.percentiles = {nearest_rank(values, 50), nearest_rank(values, 95), nearest_rank(values, 99)};
    }
    return result;
}

}  // namespace hpa
