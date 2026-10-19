#pragma once

#include <stdexcept>

namespace hpa {

/// Thrown for any invalid input or configuration. The message text is
/// identical to the TypeScript ValidationError message for the same input.
class ValidationError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

}  // namespace hpa
