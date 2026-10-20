# Node-API binding over hpa::core. Build it through cmake-js (`npm run native:build` from the
# repository root): cmake-js supplies CMAKE_JS_INC / CMAKE_JS_LIB / CMAKE_JS_SRC. It downloads the
# Node.js headers (and node.lib on Windows) for the running Node version on first use.
if(NOT CMAKE_JS_INC)
    message(FATAL_ERROR
        "The Node-API addon must be configured by cmake-js. Run `npm run native:build` from the "
        "repository root instead of invoking CMake directly.")
endif()

# node-addon-api is a pinned npm dependency (package-lock.json); resolve it through Node so
# no path is hard-coded. Override with -DHPA_NODE_ADDON_API_DIR=<dir containing napi.h>.
if(NOT HPA_NODE_ADDON_API_DIR)
    execute_process(
        COMMAND node -p "require('path').dirname(require.resolve('node-addon-api/package.json'))"
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
        OUTPUT_VARIABLE HPA_NODE_ADDON_API_DIR
        OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE node_addon_api_result)
    if(NOT node_addon_api_result EQUAL 0 OR NOT EXISTS "${HPA_NODE_ADDON_API_DIR}/napi.h")
        message(FATAL_ERROR "node-addon-api not found. Run `npm install` from the repository root.")
    endif()
endif()

# One fixed output location on every platform/generator: <build dir>/lib/<target>.node.
# The empty generator expression stops multi-config generators from appending Debug/Release.
set(HPA_ADDON_OUTPUT_DIR "${CMAKE_BINARY_DIR}/lib$<0:>")

# Declares a Node-API module linked against hpa::core with the project's settings.
function(hpa_add_napi_module target)
    add_library(${target} SHARED ${ARGN} ${CMAKE_JS_SRC})

    set_target_properties(${target} PROPERTIES
        PREFIX "" SUFFIX ".node"
        LIBRARY_OUTPUT_DIRECTORY "${HPA_ADDON_OUTPUT_DIR}"
        RUNTIME_OUTPUT_DIRECTORY "${HPA_ADDON_OUTPUT_DIR}")

    target_include_directories(${target} SYSTEM PRIVATE ${CMAKE_JS_INC} "${HPA_NODE_ADDON_API_DIR}")
    target_include_directories(${target} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
    target_link_libraries(${target} PRIVATE hpa::core ${CMAKE_JS_LIB})

    target_compile_definitions(${target} PRIVATE
        NAPI_VERSION=8
        NAPI_CPP_EXCEPTIONS
        HPA_CORE_VERSION="${PROJECT_VERSION}")

    if(MSVC)
        target_compile_options(${target} PRIVATE /W4 /permissive- /utf-8 /EHsc)
        if(HPA_WARNINGS_AS_ERRORS)
            target_compile_options(${target} PRIVATE /WX)
        endif()
    else()
        target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -fexceptions)
        if(HPA_WARNINGS_AS_ERRORS)
            target_compile_options(${target} PRIVATE -Werror)
        endif()
    endif()
endfunction()

hpa_add_napi_module(hpa_addon src/addon.cpp src/marshal.cpp)

# Experimental marshalling alternatives, benchmarked in apps/api/bench/marshalling.ts.
# Never loaded by the API. Build with `npm run native:experimental:build`.
if(HPA_BUILD_EXPERIMENTAL_ADDON)
    hpa_add_napi_module(hpa_addon_experimental experimental/experimental.cpp src/marshal.cpp)
endif()

if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
    # Generate node.lib from the symbol list supplied by cmake-js.
    execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET}
                            ${CMAKE_STATIC_LINKER_FLAGS})
endif()
