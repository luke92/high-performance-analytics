#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "hpa/limits.hpp"

// Mirrors apps/api/src/analytics/types.ts. Integers are int64_t (not the
// narrowest type) so that every out-of-range value the TypeScript validator
// rejects is also representable here and rejected with the same message.
namespace hpa {

struct Event {
    std::int64_t id = 0;         ///< 0..kMaxId; uniqueness not enforced.
    std::int64_t timestamp = 0;  ///< ms since the Unix epoch (UTC), 0..kMaxTimestamp.
    std::string event_type;      ///< 1..64 chars from [A-Za-z0-9_.-].
    std::string category;        ///< Same rules as event_type.
    double value = 0.0;          ///< Finite, |value| <= kMaxAbsValue.
};

struct GenerateOptions {
    std::int64_t seed = 0;  ///< 0..kMaxUint32
    std::int64_t count = 0;  ///< 0..kMaxEvents
    std::int64_t start_timestamp = kDefaultStartTimestamp;
    std::int64_t interval_ms = kDefaultIntervalMs;  ///< 1..kMaxIntervalMs
};

struct ComputeOptions {
    std::int64_t histogram_bins = kDefaultHistogramBins;  ///< 1..kMaxHistogramBins
};

struct CategoryEventTypeCount {
    std::string category;
    std::string event_type;
    std::int64_t count = 0;
};

struct CategoryStats {
    std::string category;
    std::int64_t count = 0;
    double sum = 0.0;
    double average = 0.0;
};

struct Summary {
    std::int64_t count = 0;
    double sum = 0.0;
    std::optional<double> average;  ///< nullopt when count == 0
    std::optional<double> min;
    std::optional<double> max;
};

struct Histogram {
    std::int64_t bin_count = 0;
    std::optional<double> min;  ///< nullopt when the dataset is empty
    std::optional<double> max;
    std::vector<double> edges;  ///< bin_count + 1 entries; empty for an empty dataset
    std::vector<std::int64_t> counts;  ///< bin_count entries
};

struct Percentiles {
    std::optional<double> p50;  ///< nearest-rank; nullopt when the dataset is empty
    std::optional<double> p95;
    std::optional<double> p99;
};

struct AnalyticsResult {
    Summary summary;
    std::vector<CategoryEventTypeCount> counts_by_category_and_type;  ///< sorted by category, event_type
    std::vector<CategoryStats> by_category;                           ///< sorted by category
    Histogram histogram;
    Percentiles percentiles;
};

}  // namespace hpa
