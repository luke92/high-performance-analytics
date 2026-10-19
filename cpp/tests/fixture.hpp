#pragma once

// Loader for cpp/tests/fixtures/parity.txt, which is generated from the
// TypeScript reference implementation (see apps/api/scripts/parityFixture.ts
// for the format).

#include <map>
#include <string>
#include <vector>

#include "hpa/types.hpp"

namespace hpa_test {

struct GenerateCase {
    std::string name;
    hpa::GenerateOptions options;
    std::vector<hpa::Event> events;
};

struct ComputeCase {
    std::string name;
    std::int64_t bins = 0;
    bool generated = false;           ///< true: events come from `options`, otherwise `events`
    hpa::GenerateOptions options;
    std::vector<hpa::Event> events;
    hpa::AnalyticsResult expected;
};

struct ParityFixture {
    std::vector<GenerateCase> generate_cases;
    std::vector<ComputeCase> compute_cases;
    std::map<std::string, std::string> errors;  ///< case name -> exact TypeScript message
};

/// Parses the fixture; throws std::runtime_error with a line number if it is malformed or missing.
const ParityFixture& parity_fixture();

}  // namespace hpa_test
