#pragma once

#include <bit>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "hpa/types.hpp"

namespace hpa_test {

/// Bit-exact comparison: distinguishes -0.0 from +0.0 and never applies a tolerance.
inline bool same_bits(double a, double b) {
    return std::bit_cast<std::uint64_t>(a) == std::bit_cast<std::uint64_t>(b);
}

inline bool same_bits(const std::optional<double>& a, const std::optional<double>& b) {
    if (a.has_value() != b.has_value()) return false;
    return !a.has_value() || same_bits(*a, *b);
}

#define HPA_EXPECT_BITS_EQ(actual, expected)                                              \
    EXPECT_TRUE(::hpa_test::same_bits((actual), (expected)))                              \
        << #actual << " differs from " << #expected << " (bit-exact comparison)"

inline hpa::Event make_event(std::int64_t id, const std::string& category, const std::string& type, double value) {
    return hpa::Event{id, 1000 * id, type, category, value};
}

/// Events with the same category and type; ids 1..n.
inline std::vector<hpa::Event> events_from_values(const std::vector<double>& values, const std::string& category = "a",
                                                  const std::string& type = "x") {
    std::vector<hpa::Event> events;
    for (std::size_t i = 0; i < values.size(); ++i) {
        events.push_back(make_event(static_cast<std::int64_t>(i) + 1, category, type, values[i]));
    }
    return events;
}

/// Values 1..n in one category.
inline std::vector<hpa::Event> sequence(int n) {
    std::vector<double> v;
    for (int i = 1; i <= n; ++i) v.push_back(i);
    return events_from_values(v, "books", "view");
}

inline void expect_events_equal(const std::vector<hpa::Event>& actual, const std::vector<hpa::Event>& expected) {
    ASSERT_EQ(actual.size(), expected.size());
    for (std::size_t i = 0; i < actual.size(); ++i) {
        SCOPED_TRACE("event index " + std::to_string(i));
        EXPECT_EQ(actual[i].id, expected[i].id);
        EXPECT_EQ(actual[i].timestamp, expected[i].timestamp);
        EXPECT_EQ(actual[i].event_type, expected[i].event_type);
        EXPECT_EQ(actual[i].category, expected[i].category);
        HPA_EXPECT_BITS_EQ(actual[i].value, expected[i].value);
        if (::testing::Test::HasFailure()) return;  // avoid flooding on large datasets
    }
}

inline void expect_result_equal(const hpa::AnalyticsResult& actual, const hpa::AnalyticsResult& expected) {
    EXPECT_EQ(actual.summary.count, expected.summary.count);
    HPA_EXPECT_BITS_EQ(actual.summary.sum, expected.summary.sum);
    HPA_EXPECT_BITS_EQ(actual.summary.average, expected.summary.average);
    HPA_EXPECT_BITS_EQ(actual.summary.min, expected.summary.min);
    HPA_EXPECT_BITS_EQ(actual.summary.max, expected.summary.max);

    HPA_EXPECT_BITS_EQ(actual.percentiles.p50, expected.percentiles.p50);
    HPA_EXPECT_BITS_EQ(actual.percentiles.p95, expected.percentiles.p95);
    HPA_EXPECT_BITS_EQ(actual.percentiles.p99, expected.percentiles.p99);

    EXPECT_EQ(actual.histogram.bin_count, expected.histogram.bin_count);
    HPA_EXPECT_BITS_EQ(actual.histogram.min, expected.histogram.min);
    HPA_EXPECT_BITS_EQ(actual.histogram.max, expected.histogram.max);
    EXPECT_EQ(actual.histogram.counts, expected.histogram.counts);
    ASSERT_EQ(actual.histogram.edges.size(), expected.histogram.edges.size());
    for (std::size_t i = 0; i < actual.histogram.edges.size(); ++i) {
        HPA_EXPECT_BITS_EQ(actual.histogram.edges[i], expected.histogram.edges[i]) << " at edge " << i;
    }

    ASSERT_EQ(actual.counts_by_category_and_type.size(), expected.counts_by_category_and_type.size());
    for (std::size_t i = 0; i < actual.counts_by_category_and_type.size(); ++i) {
        const auto& a = actual.counts_by_category_and_type[i];
        const auto& e = expected.counts_by_category_and_type[i];
        EXPECT_EQ(a.category, e.category);
        EXPECT_EQ(a.event_type, e.event_type);
        EXPECT_EQ(a.count, e.count);
    }

    ASSERT_EQ(actual.by_category.size(), expected.by_category.size());
    for (std::size_t i = 0; i < actual.by_category.size(); ++i) {
        const auto& a = actual.by_category[i];
        const auto& e = expected.by_category[i];
        EXPECT_EQ(a.category, e.category);
        EXPECT_EQ(a.count, e.count);
        HPA_EXPECT_BITS_EQ(a.sum, e.sum) << " category " << e.category;
        HPA_EXPECT_BITS_EQ(a.average, e.average) << " category " << e.category;
    }
}

}  // namespace hpa_test
