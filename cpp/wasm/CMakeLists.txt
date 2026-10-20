# WebAssembly build of hpa::core (Emscripten). Configure with `emcmake` (see cpp/wasm/build.mjs and
# `npm run wasm:build`); it cannot be built with MSVC/GCC. Output: hpa_core.js (ES module) + hpa_core.wasm.
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR
        "The WebAssembly target needs the Emscripten toolchain. Run `npm run wasm:build`, or configure "
        "with `emcmake cmake` (see cpp/README.md).")
endif()

add_executable(hpa_wasm src/wasm_api.cpp src/result_json.cpp)

target_link_libraries(hpa_wasm PRIVATE hpa::core)
target_include_directories(hpa_wasm PRIVATE src)
target_compile_definitions(hpa_wasm PRIVATE HPA_CORE_VERSION="${PROJECT_VERSION}")
target_compile_options(hpa_wasm PRIVATE -Wall -Wextra -Wpedantic)

set_target_properties(hpa_wasm PROPERTIES OUTPUT_NAME hpa_core SUFFIX ".js")

# Exceptions: the core throws hpa::ValidationError, which wasm_api.cpp catches. That needs exception
# support in every translation unit (set for the whole project in cpp/CMakeLists.txt).
#
# Memory: the heap starts at 32 MiB and may grow up to 1 GiB; the JavaScript wrapper enforces a much
# lower per-call event limit (see apps/web/src/wasm). FILESYSTEM=0 keeps the module small.
target_link_options(hpa_wasm PRIVATE
    --no-entry
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createHpaCore
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=33554432
    -sMAXIMUM_MEMORY=1073741824
    -sSTACK_SIZE=524288
    -sFILESYSTEM=0
    -sEXPORTED_RUNTIME_METHODS=HEAPU8)
