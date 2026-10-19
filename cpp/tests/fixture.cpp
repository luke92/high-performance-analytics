#include "fixture.hpp"

#include <cerrno>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace hpa_test {
namespace {

using hpa::Event;

[[noreturn]] void bad(std::size_t line, const std::string& what) {
    throw std::runtime_error("parity.txt line " + std::to_string(line) + ": " + what);
}

class Tokens {
public:
    Tokens(const std::string& text, std::size_t line) : in_(text), line_(line) {}

    std::string word() {
        std::string w;
        if (!(in_ >> w)) bad(line_, "missing token");
        return w;
    }
    std::int64_t integer() {
        const std::string w = word();
        char* end = nullptr;
        errno = 0;
        const long long v = std::strtoll(w.c_str(), &end, 10);
        if (end == w.c_str() || *end != '\0' || errno != 0) bad(line_, "bad integer '" + w + "'");
        return v;
    }
    double real() {
        const std::string w = word();
        char* end = nullptr;
        const double v = std::strtod(w.c_str(), &end);  // exact: correctly rounded in the C locale
        if (end == w.c_str() || *end != '\0') bad(line_, "bad number '" + w + "'");
        return v;
    }
    std::optional<double> optional_real() {
        const std::string w = word();
        if (w == "null") return std::nullopt;
        char* end = nullptr;
        const double v = std::strtod(w.c_str(), &end);
        if (end == w.c_str() || *end != '\0') bad(line_, "bad number '" + w + "'");
        return v;
    }
    std::string rest() {
        std::string r;
        std::getline(in_, r);
        const auto first = r.find_first_not_of(' ');
        return first == std::string::npos ? std::string() : r.substr(first);
    }
    bool more() {
        in_ >> std::ws;
        return !in_.eof();
    }

private:
    std::istringstream in_;
    std::size_t line_;
};

Event parse_event(Tokens& t) {
    Event e;
    e.id = t.integer();
    e.timestamp = t.integer();
    e.event_type = t.word();
    e.category = t.word();
    e.value = t.real();
    return e;
}

hpa::GenerateOptions parse_generate_options(Tokens& t) {
    hpa::GenerateOptions o;
    o.seed = t.integer();
    o.count = t.integer();
    o.start_timestamp = t.integer();
    o.interval_ms = t.integer();
    return o;
}

ParityFixture load() {
    const std::string path = std::string(HPA_FIXTURE_DIR) + "/parity.txt";
    std::ifstream file(path);
    if (!file) throw std::runtime_error("cannot open fixture: " + path);

    ParityFixture fx;
    GenerateCase* gen = nullptr;
    ComputeCase* cmp = nullptr;
    bool header = false;
    std::string text;
    for (std::size_t line = 1; std::getline(file, text); ++line) {
        if (!text.empty() && text.back() == '\r') text.pop_back();
        if (text.empty() || text[0] == '#') continue;
        Tokens t(text, line);
        const std::string kind = t.word();

        if (kind == "HPA-PARITY") {
            if (t.integer() != 1) bad(line, "unsupported fixture version");
            header = true;
        } else if (!header) {
            bad(line, "missing HPA-PARITY header");
        } else if (kind == "GENERATE") {
            gen = &fx.generate_cases.emplace_back();
            gen->name = t.word();
            gen->options = parse_generate_options(t);
        } else if (kind == "COMPUTE") {
            cmp = &fx.compute_cases.emplace_back();
            cmp->name = t.word();
            cmp->bins = t.integer();
            const std::string source = t.word();
            if (source == "GENERATED") {
                cmp->generated = true;
                cmp->options = parse_generate_options(t);
            } else if (source != "INLINE") {
                bad(line, "unknown source '" + source + "'");
            }
        } else if (kind == "E") {
            if (gen != nullptr) gen->events.push_back(parse_event(t));
            else if (cmp != nullptr) cmp->events.push_back(parse_event(t));
            else bad(line, "E outside a block");
        } else if (kind == "END") {
            gen = nullptr;
            cmp = nullptr;
        } else if (kind == "ERROR") {
            const std::string name = t.word();
            fx.errors.emplace(name, t.rest());
        } else if (cmp != nullptr) {
            hpa::AnalyticsResult& r = cmp->expected;
            if (kind == "SUMMARY") {
                r.summary.count = t.integer();
                r.summary.sum = t.real();
                r.summary.average = t.optional_real();
                r.summary.min = t.optional_real();
                r.summary.max = t.optional_real();
            } else if (kind == "PCT") {
                r.percentiles.p50 = t.optional_real();
                r.percentiles.p95 = t.optional_real();
                r.percentiles.p99 = t.optional_real();
            } else if (kind == "HIST") {
                r.histogram.bin_count = t.integer();
                r.histogram.min = t.optional_real();
                r.histogram.max = t.optional_real();
                const std::int64_t edge_count = t.integer();
                for (std::int64_t i = 0; i < edge_count; ++i) r.histogram.edges.push_back(t.real());
            } else if (kind == "COUNTS") {
                while (t.more()) r.histogram.counts.push_back(t.integer());
            } else if (kind == "GT") {
                hpa::CategoryEventTypeCount g;
                g.category = t.word();
                g.event_type = t.word();
                g.count = t.integer();
                r.counts_by_category_and_type.push_back(g);
            } else if (kind == "CAT") {
                hpa::CategoryStats c;
                c.category = t.word();
                c.count = t.integer();
                c.sum = t.real();
                c.average = t.real();
                r.by_category.push_back(c);
            } else {
                bad(line, "unknown record '" + kind + "'");
            }
        } else {
            bad(line, "unexpected record '" + kind + "'");
        }
    }
    if (fx.generate_cases.empty() || fx.compute_cases.empty() || fx.errors.empty()) {
        throw std::runtime_error("parity.txt is missing sections");
    }
    return fx;
}

}  // namespace

const ParityFixture& parity_fixture() {
    static const ParityFixture fixture = load();
    return fixture;
}

}  // namespace hpa_test
