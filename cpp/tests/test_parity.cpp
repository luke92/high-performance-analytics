#include <gtest/gtest.h>

#include "fixture.hpp"
#include "hpa/compute.hpp"
#include "hpa/generate.hpp"
#include "test_support.hpp"

using namespace hpa;
using namespace hpa_test;

// Every COMPUTE case in parity.txt was produced by the TypeScript implementation.
// All doubles (sums, averages, edges, percentiles, min/max) are compared bit-for-bit.
TEST(ComputeParity, MatchesEveryTypeScriptFixtureBitForBit) {
    const auto& cases = parity_fixture().compute_cases;
    ASSERT_GE(cases.size(), 20U);

    std::size_t generated = 0;
    for (const auto& c : cases) {
        SCOPED_TRACE(c.name);
        ComputeOptions options;
        options.histogram_bins = c.bins;

        if (c.generated) {
            ++generated;
            const auto events = generate_events(c.options);
            expect_result_equal(compute_analytics(events, options), c.expected);
        } else {
            expect_result_equal(compute_analytics(c.events, options), c.expected);
        }
    }
    EXPECT_GE(generated, 3U);
}

TEST(ComputeParity, FixtureContainsTheCasesThatMatterMost) {
    // Guards against the fixture silently losing its hardest cases.
    const char* required[] = {"float_sum_order", "negative_zero", "limit_values", "generated_seed7_n100000_64bins",
                              "empty_3bins",     "small_5bins",   "name_ordering"};
    for (const char* name : required) {
        bool found = false;
        for (const auto& c : parity_fixture().compute_cases) found = found || c.name == name;
        EXPECT_TRUE(found) << name;
    }
}
