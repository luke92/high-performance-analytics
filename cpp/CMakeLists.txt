cmake_minimum_required(VERSION 3.24)

project(hpa_core
    VERSION 0.2.0
    DESCRIPTION "Portable C++20 analytics core (reference-compatible with the TypeScript engine)"
    LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(HPA_BUILD_TESTS "Build the GoogleTest suite" ON)
option(HPA_WARNINGS_AS_ERRORS "Treat compiler warnings as errors" OFF)
option(HPA_BUILD_BENCH "Build the direct core benchmark executable (npm run bench:core:build)" OFF)
option(HPA_BUILD_ADDON "Build the Node-API addon (configured by cmake-js: npm run native:build)" OFF)

add_subdirectory(core)

if(HPA_BUILD_BENCH)
    add_subdirectory(bench)
endif()

if(HPA_BUILD_ADDON)
    add_subdirectory(addon)
endif()

if(HPA_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()
