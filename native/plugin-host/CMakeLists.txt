# PulseGrid's plugin host: a small program that loads VST3 instruments, plays them for the studio and opens their
# windows. The studio talks to it over its standard input and output (see src/main.cpp and electron/pluginBridge.cjs).
#
#   cmake -S native/plugin-host -B native/plugin-host/build
#   cmake --build native/plugin-host/build --config Release
#
# `npm run native` does both and copies the program to native/plugin-host/bin.

cmake_minimum_required(VERSION 3.20)
project(pulsegrid_plugin_host LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# The C++ runtime is built in, so the program runs on a PC without the Visual C++ redistributable.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(SDK ${CMAKE_CURRENT_SOURCE_DIR}/vst3sdk)

set(SDK_SOURCES
  ${SDK}/pluginterfaces/base/conststringtable.cpp
  ${SDK}/pluginterfaces/base/coreiids.cpp
  ${SDK}/pluginterfaces/base/funknown.cpp
  ${SDK}/pluginterfaces/base/ustring.cpp
  ${SDK}/public.sdk/source/common/commoniids.cpp
  ${SDK}/public.sdk/source/common/commonstringconvert.cpp
  ${SDK}/public.sdk/source/common/memorystream.cpp
  ${SDK}/public.sdk/source/common/threadchecker_win32.cpp
  ${SDK}/public.sdk/source/vst/hosting/connectionproxy.cpp
  ${SDK}/public.sdk/source/vst/hosting/eventlist.cpp
  ${SDK}/public.sdk/source/vst/hosting/hostclasses.cpp
  ${SDK}/public.sdk/source/vst/hosting/module.cpp
  ${SDK}/public.sdk/source/vst/hosting/module_win32.cpp
  ${SDK}/public.sdk/source/vst/hosting/parameterchanges.cpp
  ${SDK}/public.sdk/source/vst/hosting/pluginterfacesupport.cpp
  ${SDK}/public.sdk/source/vst/hosting/plugprovider.cpp
  ${SDK}/public.sdk/source/vst/hosting/processdata.cpp
  ${SDK}/public.sdk/source/vst/utility/stringconvert.cpp
  ${SDK}/public.sdk/source/vst/vstinitiids.cpp
)

add_executable(pulsegrid-plugin-host
  src/main.cpp
  src/instance.cpp
  src/editor.cpp
  ${SDK_SOURCES}
)

target_include_directories(pulsegrid-plugin-host PRIVATE
  ${SDK}
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
  ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(pulsegrid-plugin-host PRIVATE
  RELEASE=1
  NOMINMAX
  WIN32_LEAN_AND_MEAN
  UNICODE
  _UNICODE
  _CRT_SECURE_NO_WARNINGS
)

if(MSVC)
  target_compile_options(pulsegrid-plugin-host PRIVATE /utf-8 /W3 /EHsc /permissive-)
endif()

target_link_libraries(pulsegrid-plugin-host PRIVATE ole32 user32 shell32)

# A tiny instrument for testing the host (native/test-plugin). Not shipped with the app.
add_library(pulsegrid-test-synth MODULE ${CMAKE_CURRENT_SOURCE_DIR}/../test-plugin/testsynth.cpp
  ${SDK}/pluginterfaces/base/coreiids.cpp
  ${SDK}/pluginterfaces/base/funknown.cpp
  ${SDK}/public.sdk/source/vst/vstinitiids.cpp)
target_include_directories(pulsegrid-test-synth PRIVATE ${SDK})
target_compile_definitions(pulsegrid-test-synth PRIVATE RELEASE=1 NOMINMAX)
set_target_properties(pulsegrid-test-synth PROPERTIES OUTPUT_NAME "PulseGrid Test Synth" SUFFIX ".vst3")
if(MSVC)
  target_compile_options(pulsegrid-test-synth PRIVATE /utf-8 /W3 /EHsc /permissive-)
endif()
