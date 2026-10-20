# Node-API binding over hpa::core. Build it through cmake-js (`npm run native:build`
# from the repository root): cmake-js supplies CMAKE_JS_INC / CMAKE_JS_LIB / CMAKE_JS_SRC
# (Node-API headers come from the pinned npm package node-api-headers).
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

add_library(hpa_addon SHARED
    src/addon.cpp
    src/marshal.cpp
    ${CMAKE_JS_SRC})

set_target_properties(hpa_addon PROPERTIES PREFIX "" SUFFIX ".node")

target_include_directories(hpa_addon SYSTEM PRIVATE ${CMAKE_JS_INC} "${HPA_NODE_ADDON_API_DIR}")
target_link_libraries(hpa_addon PRIVATE hpa::core ${CMAKE_JS_LIB})

target_compile_definitions(hpa_addon PRIVATE
    NAPI_VERSION=8
    NAPI_CPP_EXCEPTIONS
    HPA_CORE_VERSION="${PROJECT_VERSION}")

if(MSVC)
    target_compile_options(hpa_addon PRIVATE /W4 /permissive- /utf-8 /EHsc)
    if(HPA_WARNINGS_AS_ERRORS)
        target_compile_options(hpa_addon PRIVATE /WX)
    endif()
else()
    target_compile_options(hpa_addon PRIVATE -Wall -Wextra -Wpedantic -fexceptions)
    if(HPA_WARNINGS_AS_ERRORS)
        target_compile_options(hpa_addon PRIVATE -Werror)
    endif()
endif()

# One fixed output location on every platform/generator: <build dir>/lib/hpa_addon.node.
# The empty generator expression stops multi-config generators from appending Debug/Release.
set(HPA_ADDON_OUTPUT_DIR "${CMAKE_BINARY_DIR}/lib$<0:>")
set_target_properties(hpa_addon PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY "${HPA_ADDON_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY "${HPA_ADDON_OUTPUT_DIR}")

if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
    # Generate node.lib from the pinned Node-API symbol list (no download needed).
    execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET}
                            ${CMAKE_STATIC_LINKER_FLAGS})
endif()
