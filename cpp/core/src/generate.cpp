#include "hpa/generate.hpp"

#include <cmath>

#include "hpa/prng.hpp"
#include "hpa/validate.hpp"

namespace hpa {

std::vector<Event> generate_events(const GenerateOptions& options) {
    validate_generate_options(options);

    Mulberry32 rng(static_cast<std::uint32_t>(options.seed));
    std::vector<Event> events;
    events.reserve(static_cast<std::size_t>(options.count));

    for (std::int64_t i = 0; i < options.count; ++i) {
        // Draw order matters: category, event type, value.
        const auto category =
            kCategories[static_cast<std::size_t>(std::floor(rng.next() * static_cast<double>(kCategories.size())))];
        const auto event_type =
            kEventTypes[static_cast<std::size_t>(std::floor(rng.next() * static_cast<double>(kEventTypes.size())))];
        const double r = rng.next();

        Event e;
        e.id = i + 1;
        e.timestamp = options.start_timestamp + i * options.interval_ms;
        e.event_type = std::string(event_type);
        e.category = std::string(category);
        e.value = std::floor(r * r * 100000.0) / 100.0;  // (r * r) * 100000, evaluated left to right
        events.push_back(std::move(e));
    }
    return events;
}

}  // namespace hpa
