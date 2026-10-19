include(FetchContent)

# GoogleTest is pinned by URL and SHA-256 for reproducible builds.
# Offline/air-gapped builds: pass -DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=<path to an extracted googletest-1.17.0>.
FetchContent_Declare(googletest
    URL https://github.com/google/googletest/releases/download/v1.17.0/googletest-1.17.0.tar.gz
    URL_HASH SHA256=65fab701d9829d38cb77c14acdc431d2108bfdbf8979e40eb8ae567edf10b27c
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)

set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
set(BUILD_GMOCK OFF CACHE BOOL "" FORCE)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)  # match the MSVC runtime of the rest of the build
FetchContent_MakeAvailable(googletest)

include(GoogleTest)

add_executable(hpa_tests
    fixture.cpp
    test_compute.cpp
    test_generate.cpp
    test_parity.cpp
    test_validation.cpp)

target_link_libraries(hpa_tests PRIVATE hpa::core GTest::gtest_main)
target_compile_definitions(hpa_tests PRIVATE HPA_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures")

if(MSVC)
    target_compile_options(hpa_tests PRIVATE /W4 /permissive- /utf-8)
else()
    target_compile_options(hpa_tests PRIVATE -Wall -Wextra -Wpedantic)
endif()

gtest_discover_tests(hpa_tests DISCOVERY_MODE PRE_TEST)
