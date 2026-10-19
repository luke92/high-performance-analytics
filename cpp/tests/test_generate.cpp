#include <set>

#include <gtest/gtest.h>

#include "fixture.hpp"
#include "hpa/generate.hpp"
#include "hpa/prng.hpp"
#include "hpa/validate.hpp"
#include "test_support.hpp"

using namespace hpa;
using namespace hpa_test;

// ---- Exact fixtures exported from the TypeScript implementation -------------

TEST(GenerateParity, MatchesEveryTypeScriptFixture) {
    const auto& cases = parity_fixture().generate_cases;
    ASSERT_GE(cases.size(), 6U);
    for (const auto& c : cases) {
        SCOPED_TRACE(c.name);
        expect_events_equal(generate_events(c.options), c.events);
    }
}

// The Stage 1 TypeScript tests pin these literally (generate.test.ts); repeating them here
// keeps the most important golden values readable next to the code. The fixture test above
// already proves they come from the TypeScript output.
TEST(GenerateParity, GoldenSeed42) {
    GenerateOptions o;
    o.seed = 42;
    o.count = 3;
    const auto events = generate_events(o);
    ASSERT_EQ(events.size(), 3U);
    EXPECT_EQ(events[0].id, 1);
    EXPECT_EQ(events[0].timestamp, 1'700'000'000'000);
    EXPECT_EQ(events[0].event_type, "click");
    EXPECT_EQ(events[0].category, "home");
    EXPECT_EQ(events[0].value, 726.69);
    EXPECT_EQ(events[1].event_type, "view");
    EXPECT_EQ(events[1].category, "home");
    EXPECT_EQ(events[1].value, 277.29);
    EXPECT_EQ(events[2].timestamp, 1'700'000'002'000);
    EXPECT_EQ(events[2].event_type, "add_to_cart");
    EXPECT_EQ(events[2].category, "clothing");
    EXPECT_EQ(events[2].value, 749.04);
}

TEST(GenerateParity, GoldenSeed0) {
    GenerateOptions o;
    o.seed = 0;
    o.count = 2;
    const auto events = generate_events(o);
    ASSERT_EQ(events.size(), 2U);
    EXPECT_EQ(events[0].event_type, "view");
    EXPECT_EQ(events[0].category, "clothing");
    EXPECT_EQ(events[0].value, 49.85);
    EXPECT_EQ(events[1].event_type, "click");
    EXPECT_EQ(events[1].category, "books");
    EXPECT_EQ(events[1].value, 297.07);
}

// ---- Determinism ------------------------------------------------------------

TEST(Generate, SameSeedAndOptionsGiveIdenticalEvents) {
    GenerateOptions o;
    o.seed = 123;
    o.count = 500;
    o.start_timestamp = 5000;
    o.interval_ms = 7;
    expect_events_equal(generate_events(o), generate_events(o));
}

TEST(Generate, DifferentSeedsDiffer) {
    GenerateOptions a;
    a.seed = 1;
    a.count = 50;
    GenerateOptions b = a;
    b.seed = 2;
    const auto ea = generate_events(a);
    const auto eb = generate_events(b);
    bool any_difference = false;
    for (std::size_t i = 0; i < ea.size(); ++i) {
        any_difference = any_difference || ea[i].value != eb[i].value || ea[i].category != eb[i].category;
    }
    EXPECT_TRUE(any_difference);
}

TEST(Generate, SmallerCountIsAPrefixOfLargerCount) {
    GenerateOptions small;
    small.seed = 9;
    small.count = 10;
    GenerateOptions large = small;
    large.count = 100;
    auto prefix = generate_events(large);
    prefix.resize(10);
    expect_events_equal(prefix, generate_events(small));
}

TEST(Generate, RepeatedCallsAreStableAcrossManyInvocations) {
    GenerateOptions o;
    o.seed = 77;
    o.count = 200;
    const auto first = generate_events(o);
    for (int i = 0; i < 5; ++i) expect_events_equal(generate_events(o), first);
}

// ---- Shape ------------------------------------------------------------------

TEST(Generate, ProducesValidEventsWithDocumentedShape) {
    GenerateOptions o;
    o.seed = 5;
    o.count = 2000;
    o.start_timestamp = 1000;
    o.interval_ms = 50;
    const auto events = generate_events(o);
    ASSERT_EQ(events.size(), 2000U);
    EXPECT_NO_THROW(validate_events(events));
    EXPECT_EQ(events.front().id, 1);
    EXPECT_EQ(events.front().timestamp, 1000);
    EXPECT_EQ(events.back().id, 2000);
    EXPECT_EQ(events.back().timestamp, 1000 + 1999 * 50);

    std::set<std::string> categories;
    std::set<std::string> types;
    for (const auto& e : events) {
        categories.insert(e.category);
        types.insert(e.event_type);
        EXPECT_GE(e.value, 0.0);
        EXPECT_LT(e.value, 1000.0);
    }
    EXPECT_EQ(categories.size(), kCategories.size());
    EXPECT_EQ(types.size(), kEventTypes.size());
}

TEST(Generate, SupportsZeroEventsAndMaximumSeed) {
    GenerateOptions o;
    o.seed = 1;
    o.count = 0;
    EXPECT_TRUE(generate_events(o).empty());
    o.seed = kMaxUint32;
    o.count = 1;
    EXPECT_EQ(generate_events(o).size(), 1U);
}

TEST(Generate, AcceptsLastTimestampExactlyAtTheRangeLimit) {
    GenerateOptions o;
    o.seed = 1;
    o.count = 3;
    o.start_timestamp = 8'639'999'999'999'998;
    o.interval_ms = 1;
    const auto events = generate_events(o);
    EXPECT_EQ(events[2].timestamp, kMaxTimestamp);
}

// ---- PRNG -------------------------------------------------------------------

TEST(Mulberry32, ReturnsValuesInUnitIntervalAndIsDeterministic) {
    Mulberry32 a(2024U);
    Mulberry32 b(2024U);
    for (int i = 0; i < 1000; ++i) {
        const double x = a.next();
        EXPECT_GE(x, 0.0);
        EXPECT_LT(x, 1.0);
        EXPECT_EQ(x, b.next());
    }
}

TEST(Mulberry32, WrapsAt32BitsLikeJavaScript) {
    // Seeds near 2^32 exercise the state increment overflow; the first generated
    // event (from the fixture, seed 4294967295) must still match TypeScript.
    const auto& cases = parity_fixture().generate_cases;
    for (const auto& c : cases) {
        if (c.options.seed != kMaxUint32) continue;
        expect_events_equal(generate_events(c.options), c.events);
        return;
    }
    FAIL() << "fixture has no max-uint32 seed case";
}
