#include "hpa/validate.hpp"

#include <cmath>
#include <string>

#include "hpa/errors.hpp"
#include "hpa/limits.hpp"

namespace hpa {
namespace {

[[noreturn]] void fail(const std::string& message) {
    throw ValidationError(message);
}

std::string int_range_message(const std::string& name, std::int64_t min, std::int64_t max) {
    return name + " must be an integer between " + std::to_string(min) + " and " + std::to_string(max);
}

bool is_name_char(char c) noexcept {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '.' ||
           c == '-';
}

/// Same rule as TypeScript: 1..64 chars from [A-Za-z0-9_.-]. Non-ASCII bytes are rejected.
bool is_valid_name(const std::string& s) noexcept {
    if (s.empty() || s.size() > kMaxStringLength) return false;
    for (const char c : s) {
        if (!is_name_char(c)) return false;
    }
    return true;
}

std::string event_field(std::size_t index, const char* field) {
    return "events[" + std::to_string(index) + "]." + field;
}

}  // namespace

void validate_events(std::span<const Event> events) {
    if (events.size() > static_cast<std::size_t>(kMaxEvents)) {
        fail("events must contain at most " + std::to_string(kMaxEvents) + " items");
    }
    for (std::size_t i = 0; i < events.size(); ++i) {
        const Event& e = events[i];
        if (e.id < 0 || e.id > kMaxId) fail(int_range_message(event_field(i, "id"), 0, kMaxId));
        if (e.timestamp < 0 || e.timestamp > kMaxTimestamp) {
            fail(int_range_message(event_field(i, "timestamp"), 0, kMaxTimestamp));
        }
        if (!is_valid_name(e.event_type)) {
            fail(event_field(i, "eventType") + " must be 1-" + std::to_string(kMaxStringLength) +
                 " characters from [A-Za-z0-9_.-]");
        }
        if (!is_valid_name(e.category)) {
            fail(event_field(i, "category") + " must be 1-" + std::to_string(kMaxStringLength) +
                 " characters from [A-Za-z0-9_.-]");
        }
        if (!std::isfinite(e.value) || std::fabs(e.value) > kMaxAbsValue) {
            fail(event_field(i, "value") + " must be a finite number with absolute value <= " +
                 std::to_string(static_cast<std::int64_t>(kMaxAbsValue)));
        }
    }
}

void validate_generate_options(const GenerateOptions& o) {
    if (o.seed < 0 || o.seed > kMaxUint32) fail(int_range_message("seed", 0, kMaxUint32));
    if (o.count < 0 || o.count > kMaxEvents) fail(int_range_message("count", 0, kMaxEvents));
    if (o.start_timestamp < 0 || o.start_timestamp > kMaxTimestamp) {
        fail(int_range_message("startTimestamp", 0, kMaxTimestamp));
    }
    if (o.interval_ms < 1 || o.interval_ms > kMaxIntervalMs) fail(int_range_message("intervalMs", 1, kMaxIntervalMs));
    // The last timestamp must stay in range. Operands are bounded above, so this cannot overflow int64.
    const std::int64_t steps = o.count > 0 ? o.count - 1 : 0;
    if (o.start_timestamp + steps * o.interval_ms > kMaxTimestamp) {
        fail("startTimestamp + (count - 1) * intervalMs exceeds the maximum timestamp");
    }
}

void validate_compute_options(const ComputeOptions& o) {
    if (o.histogram_bins < 1 || o.histogram_bins > kMaxHistogramBins) {
        fail(int_range_message("histogramBins", 1, kMaxHistogramBins));
    }
}

}  // namespace hpa
