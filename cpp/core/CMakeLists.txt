add_library(hpa_core STATIC
    src/compute.cpp
    src/generate.cpp
    src/validate.cpp)

add_library(hpa::core ALIAS hpa_core)

target_include_directories(hpa_core PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)

target_compile_features(hpa_core PUBLIC cxx_std_20)

# Bit-exact parity with the TypeScript reference requires strict IEEE 754
# double arithmetic: no fast-math and no fused multiply-add contraction.
# PRIVATE so the flags apply to the core's own translation units.
if(MSVC)
    target_compile_options(hpa_core PRIVATE /fp:strict /W4 /permissive-)
    if(HPA_WARNINGS_AS_ERRORS)
        target_compile_options(hpa_core PRIVATE /WX)
    endif()
else()
    target_compile_options(hpa_core PRIVATE -ffp-contract=off -fno-fast-math
        -Wall -Wextra -Wpedantic -Wconversion -Wshadow)
    if(HPA_WARNINGS_AS_ERRORS)
        target_compile_options(hpa_core PRIVATE -Werror)
    endif()
endif()
