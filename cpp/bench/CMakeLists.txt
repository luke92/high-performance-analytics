# Direct core benchmark (no Node.js). Build with `npm run bench:core:build`.
add_executable(hpa_bench hpa_bench.cpp)

target_link_libraries(hpa_bench PRIVATE hpa::core)

# Recorded in the benchmark report so results can be tied to a toolchain and build type.
target_compile_definitions(hpa_bench PRIVATE
    HPA_BENCH_COMPILER_ID="${CMAKE_CXX_COMPILER_ID}"
    HPA_BENCH_COMPILER_VERSION="${CMAKE_CXX_COMPILER_VERSION}"
    HPA_BENCH_BUILD_CONFIG="$<CONFIG>")

if(MSVC)
    target_compile_options(hpa_bench PRIVATE /W4 /permissive- /utf-8)
else()
    target_compile_options(hpa_bench PRIVATE -Wall -Wextra -Wpedantic)
endif()

# Fixed output location on every platform/generator: <build dir>/bin/hpa_bench(.exe).
set_target_properties(hpa_bench PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin$<0:>")
