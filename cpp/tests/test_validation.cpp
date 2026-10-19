#include <functional>
#include <limits>
#include <map>
#include <set>
#include <string>

#include <gtest/gtest.h>

#include "fixture.hpp"
#include "hpa/compute.hpp"
#include "hpa/errors.hpp"
#include "hpa/generate.hpp"
#include "test_support.hpp"

using namespace hpa;
using namespace hpa_test;

namespace {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();

Event good() {
    return make_event(1, "a", "x", 1);
}

template <typename Mutate>
std::function<void()> bad_event(Mutate mutate) {
    return [mutate] {
        Event e = good();
        mutate(e);
        const std::vector<Event> events{e};
        (void)compute_analytics(events);
    };
}

std::function<void()> bad_generate(std::int64_t seed, std::int64_t count, std::int64_t start = kDefaultStartTimestamp,
                                   std::int64_t interval = kDefaultIntervalMs) {
    return [=] {
        GenerateOptions o;
        o.seed = seed;
        o.count = count;
        o.start_timestamp = start;
        o.interval_ms = interval;
        (void)generate_events(o);
    };
}

std::function<void()> bad_bins(std::int64_t bins, bool also_bad_event = false) {
    return [=] {
        std::vector<Event> events{good()};
        if (also_bad_event) events[0].value = kNaN;
        ComputeOptions o;
        o.histogram_bins = bins;
        (void)compute_analytics(events, o);
    };
}

/// Names must match ERROR_CASES in apps/api/scripts/parityFixture.ts; the messages
/// themselves come from the TypeScript implementation via the fixture.
const std::map<std::string, std::function<void()>>& error_cases() {
    static const std::map<std::string, std::function<void()>> cases = {
        {"generate_seed_negative", bad_generate(-1, 1)},
        {"generate_seed_too_large", bad_generate(4'294'967'296, 1)},
        {"generate_count_negative", bad_generate(1, -1)},
        {"generate_count_too_large", bad_generate(1, 5'000'001)},
        {"generate_interval_zero", bad_generate(1, 1, kDefaultStartTimestamp, 0)},
        {"generate_interval_too_large", bad_generate(1, 1, kDefaultStartTimestamp, 86'400'001)},
        {"generate_start_negative", bad_generate(1, 1, -5)},
        {"generate_timestamp_overflow", bad_generate(1, 3, 8'640'000'000'000'000, 1)},
        {"generate_first_error_wins", bad_generate(-1, -1, kDefaultStartTimestamp, 0)},
        {"event_id_negative", bad_event([](Event& e) { e.id = -1; })},
        {"event_id_too_large", bad_event([](Event& e) { e.id = kMaxId + 1; })},
        {"event_timestamp_negative", bad_event([](Event& e) { e.timestamp = -1; })},
        {"event_timestamp_too_large", bad_event([](Event& e) { e.timestamp = kMaxTimestamp + 1; })},
        {"event_type_empty", bad_event([](Event& e) { e.event_type = ""; })},
        {"event_type_too_long", bad_event([](Event& e) { e.event_type = std::string(65, 'x'); })},
        {"event_type_bad_char", bad_event([](Event& e) { e.event_type = "a/b"; })},
        {"event_category_empty", bad_event([](Event& e) { e.category = ""; })},
        {"event_category_space", bad_event([](Event& e) { e.category = "a b"; })},
        {"event_category_non_ascii", bad_event([](Event& e) { e.category = "caf\xC3\xA9"; })},
        {"event_value_nan", bad_event([](Event& e) { e.value = kNaN; })},
        {"event_value_infinity", bad_event([](Event& e) { e.value = kInf; })},
        {"event_value_neg_infinity", bad_event([](Event& e) { e.value = -kInf; })},
        {"event_value_over_limit", bad_event([](Event& e) { e.value = 1e12 + 1; })},
        {"event_first_error_wins", bad_event([](Event& e) { e.id = -1; e.value = kNaN; })},
        {"event_index_in_message",
         [] {
             std::vector<Event> events{good(), good()};
             events[1].value = kNaN;
             (void)compute_analytics(events);
         }},
        {"bins_zero", bad_bins(0)},
        {"bins_negative", bad_bins(-1)},
        {"bins_too_large", bad_bins(1025)},
        {"events_checked_before_bins", bad_bins(0, true)},
    };
    return cases;
}

}  // namespace

TEST(ValidationParity, EveryTypeScriptErrorCaseHasACppCounterpartAndViceVersa) {
    std::set<std::string> from_fixture;
    for (const auto& [name, message] : parity_fixture().errors) from_fixture.insert(name);
    std::set<std::string> from_cpp;
    for (const auto& [name, run] : error_cases()) from_cpp.insert(name);
    EXPECT_EQ(from_fixture, from_cpp);
}

TEST(ValidationParity, ThrowsValidationErrorWithTheExactTypeScriptMessage) {
    for (const auto& [name, expected_message] : parity_fixture().errors) {
        SCOPED_TRACE(name);
        const auto it = error_cases().find(name);
        ASSERT_NE(it, error_cases().end());
        try {
            it->second();
            ADD_FAILURE() << "did not throw";
        } catch (const ValidationError& e) {
            EXPECT_EQ(std::string(e.what()), expected_message);
        } catch (const std::exception& e) {
            ADD_FAILURE() << "wrong exception type: " << e.what();
        }
    }
}

TEST(Validation, AcceptsValuesExactlyAtTheLimits) {
    std::vector<Event> events{good(), good()};
    events[0].value = 1e12;
    events[1].value = -1e12;
    events[0].id = kMaxId;
    events[1].timestamp = kMaxTimestamp;
    EXPECT_NO_THROW(compute_analytics(events));
}

TEST(Validation, AcceptsNameBoundaries) {
    Event e = good();
    e.category = std::string(64, 'Z');
    e.event_type = "A-z_0.9";
    const std::vector<Event> events{e};
    EXPECT_NO_THROW(compute_analytics(events));
}

TEST(Validation, AcceptsHistogramBinBounds) {
    const std::vector<Event> events{good()};
    ComputeOptions o;
    o.histogram_bins = 1;
    EXPECT_EQ(compute_analytics(events, o).histogram.counts.size(), 1U);
    o.histogram_bins = 1024;
    EXPECT_EQ(compute_analytics(events, o).histogram.counts.size(), 1024U);
}

TEST(Validation, ValidatesBeforeComputingAnything) {
    // The invalid event is last; nothing may be returned for the valid prefix.
    std::vector<Event> events = sequence(1000);
    events.back().value = kInf;
    EXPECT_THROW((void)compute_analytics(events), ValidationError);
}
