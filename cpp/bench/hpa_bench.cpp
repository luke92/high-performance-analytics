// Direct benchmark of hpa::core: no Node.js, no JS marshalling. Prints JSON on stdout.
//
//   hpa_bench [--sizes=10000,100000,1000000] [--seed=42] [--bins=10] [--warmup=3] [--runs=10]
//
// Per size, three phases are timed separately with std::chrono::steady_clock (monotonic):
//   generate  hpa::generate_events                       (includes its own option validation)
//   validate  hpa::validate_events
//   compute   hpa::compute_analytics                      (includes validate_events, like the TS engine)
// The last compute result is emitted in full (doubles with 17 significant digits, which round-trip
// exactly) so the harness can require bit-identical agreement with the TypeScript engine before it
// accepts any timing. Nothing here is used by production code.

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <string>
#include <vector>

#include "hpa/compute.hpp"
#include "hpa/generate.hpp"
#include "hpa/validate.hpp"

#ifndef HPA_BENCH_COMPILER_ID
#define HPA_BENCH_COMPILER_ID "unknown"
#endif
#ifndef HPA_BENCH_COMPILER_VERSION
#define HPA_BENCH_COMPILER_VERSION "unknown"
#endif
#ifndef HPA_BENCH_BUILD_CONFIG
#define HPA_BENCH_BUILD_CONFIG ""
#endif

namespace {

using Clock = std::chrono::steady_clock;

double elapsed_ms(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

struct Args {
    std::vector<std::int64_t> sizes{10'000, 100'000, 1'000'000};
    std::int64_t seed = 42;
    std::int64_t bins = 10;
    int warmup = 3;
    int runs = 10;
};

bool parse_int(const std::string& text, std::int64_t& out) {
    char* end = nullptr;
    const long long v = std::strtoll(text.c_str(), &end, 10);
    if (text.empty() || *end != '\0') return false;
    out = v;
    return true;
}

bool parse_args(int argc, char** argv, Args& args) {
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        const auto eq = arg.find('=');
        if (arg.rfind("--", 0) != 0 || eq == std::string::npos) return false;
        const std::string key = arg.substr(2, eq - 2);
        const std::string value = arg.substr(eq + 1);
        std::int64_t n = 0;
        if (key == "sizes") {
            args.sizes.clear();
            std::size_t pos = 0;
            while (pos <= value.size()) {
                const auto comma = value.find(',', pos);
                const std::string part = value.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
                if (!parse_int(part, n) || n < 1 || n > hpa::kMaxEvents) return false;
                args.sizes.push_back(n);
                if (comma == std::string::npos) break;
                pos = comma + 1;
            }
        } else if (key == "seed" && parse_int(value, n)) {
            args.seed = n;
        } else if (key == "bins" && parse_int(value, n)) {
            args.bins = n;
        } else if (key == "warmup" && parse_int(value, n) && n >= 0 && n <= 1000) {
            args.warmup = static_cast<int>(n);
        } else if (key == "runs" && parse_int(value, n) && n >= 1 && n <= 1000) {
            args.runs = static_cast<int>(n);
        } else {
            return false;
        }
    }
    return !args.sizes.empty();
}

// ---- JSON output (shapes and key order mirror the TypeScript AnalyticsResult) ----------------

std::string num(double v) {
    char buf[40];
    std::snprintf(buf, sizeof buf, "%.17g", v);  // round-trips exactly; prints "-0" for negative zero
    return buf;
}

std::string opt(const std::optional<double>& v) {
    return v ? num(*v) : "null";
}

void print_samples(const char* name, const std::vector<double>& samples) {
    std::printf("\"%s\":[", name);
    for (std::size_t i = 0; i < samples.size(); ++i) std::printf("%s%s", i ? "," : "", num(samples[i]).c_str());
    std::printf("]");
}

void print_result(const hpa::AnalyticsResult& r) {
    std::printf("{\"summary\":{\"count\":%lld,\"sum\":%s,\"average\":%s,\"min\":%s,\"max\":%s},",
                static_cast<long long>(r.summary.count), num(r.summary.sum).c_str(), opt(r.summary.average).c_str(),
                opt(r.summary.min).c_str(), opt(r.summary.max).c_str());
    std::printf("\"countsByCategoryAndType\":[");
    for (std::size_t i = 0; i < r.counts_by_category_and_type.size(); ++i) {
        const auto& g = r.counts_by_category_and_type[i];
        std::printf("%s{\"category\":\"%s\",\"eventType\":\"%s\",\"count\":%lld}", i ? "," : "", g.category.c_str(),
                    g.event_type.c_str(), static_cast<long long>(g.count));
    }
    std::printf("],\"byCategory\":[");
    for (std::size_t i = 0; i < r.by_category.size(); ++i) {
        const auto& c = r.by_category[i];
        std::printf("%s{\"category\":\"%s\",\"count\":%lld,\"sum\":%s,\"average\":%s}", i ? "," : "", c.category.c_str(),
                    static_cast<long long>(c.count), num(c.sum).c_str(), num(c.average).c_str());
    }
    std::printf("],\"histogram\":{\"binCount\":%lld,\"min\":%s,\"max\":%s,\"edges\":[",
                static_cast<long long>(r.histogram.bin_count), opt(r.histogram.min).c_str(),
                opt(r.histogram.max).c_str());
    for (std::size_t i = 0; i < r.histogram.edges.size(); ++i) {
        std::printf("%s%s", i ? "," : "", num(r.histogram.edges[i]).c_str());
    }
    std::printf("],\"counts\":[");
    for (std::size_t i = 0; i < r.histogram.counts.size(); ++i) {
        std::printf("%s%lld", i ? "," : "", static_cast<long long>(r.histogram.counts[i]));
    }
    std::printf("]},\"percentiles\":{\"p50\":%s,\"p95\":%s,\"p99\":%s}}", opt(r.percentiles.p50).c_str(),
                opt(r.percentiles.p95).c_str(), opt(r.percentiles.p99).c_str());
}

}  // namespace

int main(int argc, char** argv) {
    Args args;
    if (!parse_args(argc, argv, args)) {
        std::fprintf(stderr,
                     "usage: hpa_bench [--sizes=N,N,...] [--seed=N] [--bins=N] [--warmup=N] [--runs=N]\n");
        return 2;
    }

    const char* config = HPA_BENCH_BUILD_CONFIG;
    std::printf("{\"tool\":\"hpa_bench\",\"build\":{\"compiler\":\"%s\",\"compilerVersion\":\"%s\",\"config\":\"%s\","
                "\"cppStandard\":\"C++20\"},\"config\":{\"seed\":%lld,\"bins\":%lld,\"warmup\":%d,\"runs\":%d},"
                "\"results\":[",
                HPA_BENCH_COMPILER_ID, HPA_BENCH_COMPILER_VERSION, config[0] ? config : "unspecified",
                static_cast<long long>(args.seed), static_cast<long long>(args.bins), args.warmup, args.runs);

    volatile double sink = 0.0;  // keeps the optimizer from discarding the timed work
    try {
        for (std::size_t s = 0; s < args.sizes.size(); ++s) {
            hpa::GenerateOptions gen;
            gen.seed = args.seed;
            gen.count = args.sizes[s];
            hpa::ComputeOptions opts;
            opts.histogram_bins = args.bins;

            std::vector<hpa::Event> events;
            std::vector<double> generate_ms, validate_ms, compute_ms;
            hpa::AnalyticsResult result;

            for (int i = 0; i < args.warmup + args.runs; ++i) {
                const bool timed = i >= args.warmup;
                auto t = Clock::now();
                events = hpa::generate_events(gen);
                if (timed) generate_ms.push_back(elapsed_ms(t));
                sink = sink + static_cast<double>(events.size());

                t = Clock::now();
                hpa::validate_events(events);
                if (timed) validate_ms.push_back(elapsed_ms(t));

                t = Clock::now();
                result = hpa::compute_analytics(events, opts);
                if (timed) compute_ms.push_back(elapsed_ms(t));
                sink = sink + result.summary.sum;
            }

            std::printf("%s{\"events\":%lld,", s ? "," : "", static_cast<long long>(args.sizes[s]));
            print_samples("generateMs", generate_ms);
            std::printf(",");
            print_samples("validateMs", validate_ms);
            std::printf(",");
            print_samples("computeMs", compute_ms);
            std::printf(",\"result\":");
            print_result(result);
            std::printf("}");
            std::fflush(stdout);
        }
    } catch (const std::exception& e) {
        std::fprintf(stderr, "hpa_bench failed: %s\n", e.what());
        return 1;
    }
    std::printf("]}\n");
    return 0;
}
