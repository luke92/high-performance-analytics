#include <algorithm>
#include <string>
#include <tuple>
#include <vector>

#include <gtest/gtest.h>

#include "hpa/compute.hpp"
#include "hpa/errors.hpp"
#include "test_support.hpp"

using namespace hpa;
using namespace hpa_test;

namespace {

ComputeOptions bins(std::int64_t n) {
    ComputeOptions o;
    o.histogram_bins = n;
    return o;
}

// Hand-verified dataset (same as the TypeScript tests): sorted values 5, 10, 15, 20, 30; sum 80.
std::vector<Event> small_dataset() {
    return {
        make_event(1, "books", "view", 10),
        make_event(2, "books", "click", 20),
        make_event(3, "books", "view", 30),
        make_event(4, "toys", "purchase", 5),
        make_event(5, "toys", "view", 15),
    };
}

}  // namespace

// ---- Known small dataset -----------------------------------------------------

TEST(ComputeSmall, SummarisesTheDataset) {
    const auto r = compute_analytics(small_dataset(), bins(5));
    EXPECT_EQ(r.summary.count, 5);
    EXPECT_EQ(r.summary.sum, 80.0);
    EXPECT_EQ(r.summary.average, 16.0);
    EXPECT_EQ(r.summary.min, 5.0);
    EXPECT_EQ(r.summary.max, 30.0);
}

TEST(ComputeSmall, CountsByCategoryAndTypeAreSorted) {
    const auto r = compute_analytics(small_dataset(), bins(5));
    ASSERT_EQ(r.counts_by_category_and_type.size(), 4U);
    const std::vector<std::tuple<std::string, std::string, std::int64_t>> expected = {
        {"books", "click", 1}, {"books", "view", 2}, {"toys", "purchase", 1}, {"toys", "view", 1}};
    for (std::size_t i = 0; i < expected.size(); ++i) {
        EXPECT_EQ(r.counts_by_category_and_type[i].category, std::get<0>(expected[i]));
        EXPECT_EQ(r.counts_by_category_and_type[i].event_type, std::get<1>(expected[i]));
        EXPECT_EQ(r.counts_by_category_and_type[i].count, std::get<2>(expected[i]));
    }
}

TEST(ComputeSmall, SumAndAverageByCategory) {
    const auto r = compute_analytics(small_dataset(), bins(5));
    ASSERT_EQ(r.by_category.size(), 2U);
    EXPECT_EQ(r.by_category[0].category, "books");
    EXPECT_EQ(r.by_category[0].count, 3);
    EXPECT_EQ(r.by_category[0].sum, 60.0);
    EXPECT_EQ(r.by_category[0].average, 20.0);
    EXPECT_EQ(r.by_category[1].category, "toys");
    EXPECT_EQ(r.by_category[1].count, 2);
    EXPECT_EQ(r.by_category[1].sum, 20.0);
    EXPECT_EQ(r.by_category[1].average, 10.0);
}

TEST(ComputeSmall, NearestRankPercentiles) {
    // n = 5: rank(p50) = ceil(2.5) = 3 -> 15; rank(p95) = ceil(4.75) = 5 -> 30; rank(p99) = 5 -> 30
    const auto r = compute_analytics(small_dataset(), bins(5));
    EXPECT_EQ(r.percentiles.p50, 15.0);
    EXPECT_EQ(r.percentiles.p95, 30.0);
    EXPECT_EQ(r.percentiles.p99, 30.0);
}

TEST(ComputeSmall, HistogramWithFiveBins) {
    const auto h = compute_analytics(small_dataset(), bins(5)).histogram;
    EXPECT_EQ(h.bin_count, 5);
    EXPECT_EQ(h.min, 5.0);
    EXPECT_EQ(h.max, 30.0);
    EXPECT_EQ(h.edges, (std::vector<double>{5, 10, 15, 20, 25, 30}));
    EXPECT_EQ(h.counts, (std::vector<std::int64_t>{1, 1, 1, 1, 1}));
}

TEST(ComputeSmall, DefaultsToTenBins) {
    const auto h = compute_analytics(small_dataset()).histogram;
    EXPECT_EQ(h.bin_count, 10);
    EXPECT_EQ(h.counts.size(), 10U);
}

// ---- Empty dataset ------------------------------------------------------------

TEST(ComputeEmpty, ReturnsZeroCountsAndAbsentStatistics) {
    const auto r = compute_analytics({}, bins(3));
    EXPECT_EQ(r.summary.count, 0);
    EXPECT_EQ(r.summary.sum, 0.0);
    EXPECT_FALSE(r.summary.average.has_value());
    EXPECT_FALSE(r.summary.min.has_value());
    EXPECT_FALSE(r.summary.max.has_value());
    EXPECT_TRUE(r.counts_by_category_and_type.empty());
    EXPECT_TRUE(r.by_category.empty());
    EXPECT_FALSE(r.percentiles.p50.has_value());
    EXPECT_FALSE(r.percentiles.p95.has_value());
    EXPECT_FALSE(r.percentiles.p99.has_value());
}

TEST(ComputeEmpty, HistogramHasNoRangeNoEdgesAndZeroedBins) {
    const auto h = compute_analytics({}, bins(3)).histogram;
    EXPECT_EQ(h.bin_count, 3);
    EXPECT_FALSE(h.min.has_value());
    EXPECT_FALSE(h.max.has_value());
    EXPECT_TRUE(h.edges.empty());
    EXPECT_EQ(h.counts, (std::vector<std::int64_t>{0, 0, 0}));
}

// ---- Histogram boundaries -----------------------------------------------------

TEST(ComputeHistogram, MinimumInFirstBinAndMaximumInClosedLastBin) {
    // width 12.5: [5, 17.5) holds 5, 10, 15; [17.5, 30] holds 20, 30
    const auto h = compute_analytics(small_dataset(), bins(2)).histogram;
    EXPECT_EQ(h.edges, (std::vector<double>{5, 17.5, 30}));
    EXPECT_EQ(h.counts, (std::vector<std::int64_t>{3, 2}));
}

TEST(ComputeHistogram, ValueOnInteriorEdgeGoesToUpperBin) {
    const auto h = compute_analytics(events_from_values({0, 5, 10}), bins(2)).histogram;
    EXPECT_EQ(h.counts, (std::vector<std::int64_t>{1, 2}));
}

TEST(ComputeHistogram, EqualValuesAllLandInBinZero) {
    const auto h = compute_analytics(events_from_values({7, 7, 7}), bins(4)).histogram;
    EXPECT_EQ(h.counts, (std::vector<std::int64_t>{3, 0, 0, 0}));
    EXPECT_EQ(h.min, 7.0);
    EXPECT_EQ(h.max, 7.0);
}

TEST(ComputeHistogram, SingleBinAndNegativeValues) {
    const auto events = events_from_values({-10, 0, 10});
    const auto one = compute_analytics(events, bins(1)).histogram;
    EXPECT_EQ(one.edges, (std::vector<double>{-10, 10}));
    EXPECT_EQ(one.counts, (std::vector<std::int64_t>{3}));
    EXPECT_EQ(compute_analytics(events, bins(4)).histogram.counts, (std::vector<std::int64_t>{1, 0, 1, 1}));
}

TEST(ComputeHistogram, EveryEventIsCountedForManyBinCounts) {
    const auto events = sequence(1000);
    for (const std::int64_t b : {1, 3, 7, 10, 64, 1024}) {
        const auto counts = compute_analytics(events, bins(b)).histogram.counts;
        std::int64_t total = 0;
        for (const auto c : counts) total += c;
        EXPECT_EQ(total, 1000) << "bins=" << b;
    }
}

// ---- Percentiles ----------------------------------------------------------------

TEST(ComputePercentiles, OneToHundred) {
    const auto p = compute_analytics(sequence(100)).percentiles;
    EXPECT_EQ(p.p50, 50.0);
    EXPECT_EQ(p.p95, 95.0);
    EXPECT_EQ(p.p99, 99.0);
}

TEST(ComputePercentiles, RankRoundsUpWithoutInterpolation) {
    auto p = compute_analytics(sequence(10)).percentiles;  // ranks 5, 10, 10
    EXPECT_EQ(p.p50, 5.0);
    EXPECT_EQ(p.p95, 10.0);
    EXPECT_EQ(p.p99, 10.0);
    p = compute_analytics(sequence(2)).percentiles;  // ranks 1, 2, 2
    EXPECT_EQ(p.p50, 1.0);
    EXPECT_EQ(p.p95, 2.0);
    EXPECT_EQ(p.p99, 2.0);
}

TEST(ComputePercentiles, SingleValue) {
    const auto p = compute_analytics(sequence(1)).percentiles;
    EXPECT_EQ(p.p50, 1.0);
    EXPECT_EQ(p.p95, 1.0);
    EXPECT_EQ(p.p99, 1.0);
}

TEST(ComputePercentiles, DuplicateValues) {
    auto p = compute_analytics(events_from_values({1, 1, 1, 1, 100})).percentiles;
    EXPECT_EQ(p.p50, 1.0);
    EXPECT_EQ(p.p95, 100.0);
    EXPECT_EQ(p.p99, 100.0);
    p = compute_analytics(events_from_values({7, 7, 7, 7})).percentiles;
    EXPECT_EQ(p.p50, 7.0);
    EXPECT_EQ(p.p95, 7.0);
    EXPECT_EQ(p.p99, 7.0);
}

TEST(ComputePercentiles, IndependentOfInputOrder) {
    auto forward = sequence(101);
    auto reversed = forward;
    std::reverse(reversed.begin(), reversed.end());
    const auto a = compute_analytics(forward).percentiles;
    const auto b = compute_analytics(reversed).percentiles;
    EXPECT_EQ(a.p50, b.p50);
    EXPECT_EQ(a.p95, b.p95);
    EXPECT_EQ(a.p99, b.p99);
}

TEST(ComputePercentiles, AreOrderedAndWithinRange) {
    const auto r = compute_analytics(sequence(37));
    EXPECT_LE(*r.percentiles.p50, *r.percentiles.p95);
    EXPECT_LE(*r.percentiles.p95, *r.percentiles.p99);
    EXPECT_GE(*r.percentiles.p50, *r.summary.min);
    EXPECT_LE(*r.percentiles.p99, *r.summary.max);
}

TEST(ComputePercentiles, NegativeZeroOrderingIsObservableWhenInputIsNotPreSorted) {
    // Float64Array.sort gives [-0, -0, 0, 0]; p50 = rank 2 = -0. A comparator that treats
    // the zeros as equal would leave [0, 0, -0, -0] and return +0 here.
    const auto p = compute_analytics(events_from_values({0.0, 0.0, -0.0, -0.0})).percentiles;
    EXPECT_TRUE(same_bits(p.p50, std::optional<double>(-0.0)));
    EXPECT_TRUE(same_bits(p.p95, std::optional<double>(0.0)));
}

TEST(ComputePercentiles, NegativeZeroSortsBeforePositiveZeroLikeTypeScript) {
    // sorted = [-0, -0, 0, 5]; p50 rank = 2 -> -0 (sign bit must be preserved)
    const auto p = compute_analytics(events_from_values({0.0, -0.0, -0.0, 5.0})).percentiles;
    EXPECT_TRUE(same_bits(p.p50, std::optional<double>(-0.0)));
    EXPECT_TRUE(same_bits(p.p95, std::optional<double>(5.0)));
}

// ---- Grouping, ordering, aggregation ---------------------------------------------

TEST(ComputeGrouping, ResultsDoNotDependOnInputOrderForExactData) {
    auto shuffled = small_dataset();
    std::swap(shuffled[0], shuffled[3]);
    std::swap(shuffled[1], shuffled[4]);
    std::swap(shuffled[2], shuffled[4]);
    expect_result_equal(compute_analytics(shuffled, bins(5)), compute_analytics(small_dataset(), bins(5)));
}

TEST(ComputeGrouping, KeepsGroupsSeparateAndTotalsConsistent) {
    const std::vector<Event> events = {
        make_event(1, "a", "x", 1), make_event(2, "a", "y", 2), make_event(3, "b", "x", 3),
        make_event(4, "b", "x", 4), make_event(5, "c", "z", 5),
    };
    const auto r = compute_analytics(events);
    ASSERT_EQ(r.by_category.size(), 3U);
    EXPECT_EQ(r.by_category[0].category, "a");
    EXPECT_EQ(r.by_category[1].category, "b");
    EXPECT_EQ(r.by_category[2].category, "c");
    std::int64_t grouped = 0;
    for (const auto& g : r.counts_by_category_and_type) grouped += g.count;
    EXPECT_EQ(grouped, 5);
    double category_sum = 0;
    for (const auto& c : r.by_category) category_sum += c.sum;
    EXPECT_EQ(category_sum, r.summary.sum);
    bool found = false;
    for (const auto& g : r.counts_by_category_and_type) {
        if (g.category == "b" && g.event_type == "x") {
            EXPECT_EQ(g.count, 2);
            found = true;
        }
    }
    EXPECT_TRUE(found);
}

TEST(ComputeGrouping, NamesSortInByteOrderUppercaseBeforeLowercase) {
    const std::vector<Event> events = {make_event(1, "b", "x", 1), make_event(2, "B", "x", 1),
                                       make_event(3, "a", "y", 1), make_event(4, "a", "X", 1)};
    const auto r = compute_analytics(events);
    ASSERT_EQ(r.by_category.size(), 3U);
    EXPECT_EQ(r.by_category[0].category, "B");
    EXPECT_EQ(r.by_category[1].category, "a");
    EXPECT_EQ(r.by_category[2].category, "b");
    ASSERT_EQ(r.counts_by_category_and_type.size(), 4U);
    EXPECT_EQ(r.counts_by_category_and_type[1].event_type, "X");  // "a"/"X" before "a"/"y"
    EXPECT_EQ(r.counts_by_category_and_type[2].event_type, "y");
}

TEST(ComputeGrouping, SumsDoublesSequentiallyInInputOrderWithoutCompensation) {
    const auto r = compute_analytics(events_from_values({0.1, 0.2, 0.3}));
    EXPECT_EQ(r.summary.sum, 0.1 + 0.2 + 0.3);  // 0.6000000000000001, evaluated left to right
    EXPECT_NE(r.summary.sum, 0.6);
    const double reordered = 0.3 + 0.2 + 0.1;
    const auto rev = compute_analytics(events_from_values({0.3, 0.2, 0.1}));
    EXPECT_EQ(rev.summary.sum, reordered);
}

TEST(ComputeGrouping, HandlesNegativeValues) {
    const auto r = compute_analytics(events_from_values({-4, 2}));
    EXPECT_EQ(r.summary.sum, -2.0);
    EXPECT_EQ(r.summary.average, -1.0);
    EXPECT_EQ(r.summary.min, -4.0);
    EXPECT_EQ(r.summary.max, 2.0);
}

TEST(ComputeGrouping, MinimumKeepsFirstOfNegativeAndPositiveZeroLikeTypeScript) {
    // TypeScript's `v < min` never replaces +0 with -0, so min stays +0 here.
    const auto r = compute_analytics(events_from_values({0.0, -0.0}));
    EXPECT_TRUE(same_bits(r.summary.min, std::optional<double>(0.0)));
    EXPECT_TRUE(same_bits(r.summary.max, std::optional<double>(0.0)));
}

TEST(ComputeGrouping, RepeatedCallsGiveIdenticalResults) {
    const auto events = small_dataset();
    const auto first = compute_analytics(events, bins(4));
    for (int i = 0; i < 3; ++i) expect_result_equal(compute_analytics(events, bins(4)), first);
}

TEST(ComputeGrouping, DoesNotModifyItsInput) {
    const auto events = small_dataset();
    auto copy = events;
    (void)compute_analytics(events);
    expect_events_equal(events, copy);
}
