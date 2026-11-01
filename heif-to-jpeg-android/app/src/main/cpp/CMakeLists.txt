cmake_minimum_required(VERSION 3.22.1)
project(heif2jpeg C CXX)

# Software HEIF/HEVC decoding (libheif + libde265), built from source so the app
# can decode HEVC "Main 4:2:2 10" camera files (Sony/Canon/Fujifilm .HIF etc.)
# that most phone hardware decoders reject.

include(ExternalProject)

set(LIBDE265_TAG v1.0.16)
set(LIBHEIF_TAG v1.20.2)

set(DEPS_PREFIX ${CMAKE_BINARY_DIR}/deps)
set(DEPS_INSTALL ${DEPS_PREFIX}/install)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Arguments forwarded to the dependency builds so they use the same toolchain
# (Android NDK when built by Gradle, host compiler when built standalone).
set(FORWARD_ARGS
    -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_INSTALL_PREFIX=${DEPS_INSTALL}
    -DCMAKE_INSTALL_LIBDIR=lib
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON
    -DBUILD_SHARED_LIBS=OFF
)
if(CMAKE_MAKE_PROGRAM)
    list(APPEND FORWARD_ARGS -DCMAKE_MAKE_PROGRAM=${CMAKE_MAKE_PROGRAM})
endif()
if(CMAKE_TOOLCHAIN_FILE)
    list(APPEND FORWARD_ARGS -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE})
endif()
if(ANDROID)
    list(APPEND FORWARD_ARGS
        -DANDROID_ABI=${ANDROID_ABI}
        -DANDROID_PLATFORM=${ANDROID_PLATFORM}
        -DANDROID_STL=${ANDROID_STL}
    )
endif()

ExternalProject_Add(libde265_ext
    GIT_REPOSITORY https://github.com/strukturag/libde265.git
    GIT_TAG ${LIBDE265_TAG}
    GIT_SHALLOW TRUE
    PREFIX ${DEPS_PREFIX}/libde265
    CMAKE_ARGS ${FORWARD_ARGS}
        -DENABLE_SDL=OFF
        -DENABLE_DECODER=OFF
        -DENABLE_ENCODER=OFF
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5
    BUILD_BYPRODUCTS ${DEPS_INSTALL}/lib/libde265.a
)

ExternalProject_Add(libheif_ext
    GIT_REPOSITORY https://github.com/strukturag/libheif.git
    GIT_TAG ${LIBHEIF_TAG}
    GIT_SHALLOW TRUE
    PREFIX ${DEPS_PREFIX}/libheif
    DEPENDS libde265_ext
    CMAKE_ARGS ${FORWARD_ARGS}
        -DCMAKE_PREFIX_PATH=${DEPS_INSTALL}
        -DCMAKE_FIND_ROOT_PATH=${DEPS_INSTALL}
        -DLIBDE265_INCLUDE_DIR=${DEPS_INSTALL}/include
        -DLIBDE265_LIBRARY=${DEPS_INSTALL}/lib/libde265.a
        -DWITH_LIBDE265=ON
        -DWITH_X265=OFF
        -DWITH_KVAZAAR=OFF
        -DWITH_UVG266=OFF
        -DWITH_VVDEC=OFF
        -DWITH_VVENC=OFF
        -DWITH_AOM_DECODER=OFF
        -DWITH_AOM_ENCODER=OFF
        -DWITH_DAV1D=OFF
        -DWITH_RAV1E=OFF
        -DWITH_SvtEnc=OFF
        -DWITH_FFMPEG_DECODER=OFF
        -DWITH_JPEG_DECODER=OFF
        -DWITH_JPEG_ENCODER=OFF
        -DWITH_OpenJPEG_DECODER=OFF
        -DWITH_OpenJPEG_ENCODER=OFF
        -DWITH_OPENJPH_ENCODER=OFF
        -DWITH_OpenH264_DECODER=OFF
        -DWITH_UNCOMPRESSED_CODEC=OFF
        -DWITH_HEADER_COMPRESSION=OFF
        -DWITH_LIBSHARPYUV=OFF
        -DWITH_GDK_PIXBUF=OFF
        -DWITH_EXAMPLES=OFF
        -DWITH_EXAMPLE_HEIF_VIEW=OFF
        -DWITH_EXAMPLE_HEIF_THUMB=OFF
        -DBUILD_TESTING=OFF
        -DBUILD_DOCUMENTATION=OFF
        -DENABLE_PLUGIN_LOADING=OFF
        -DCMAKE_DISABLE_FIND_PACKAGE_Doxygen=ON
    BUILD_BYPRODUCTS ${DEPS_INSTALL}/lib/libheif.a
)

file(MAKE_DIRECTORY ${DEPS_INSTALL}/include)

add_library(de265_static STATIC IMPORTED)
set_target_properties(de265_static PROPERTIES IMPORTED_LOCATION ${DEPS_INSTALL}/lib/libde265.a)
add_dependencies(de265_static libde265_ext)

add_library(heif_static STATIC IMPORTED)
set_target_properties(heif_static PROPERTIES
    IMPORTED_LOCATION ${DEPS_INSTALL}/lib/libheif.a
    INTERFACE_INCLUDE_DIRECTORIES ${DEPS_INSTALL}/include
    INTERFACE_COMPILE_DEFINITIONS LIBHEIF_STATIC_BUILD)
add_dependencies(heif_static libheif_ext)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(heif2jpeg SHARED heif2jpeg.cpp jpeg_encoder.cpp)
target_compile_options(heif2jpeg PRIVATE -O3 -Wall)

if(ANDROID)
    target_link_libraries(heif2jpeg heif_static de265_static log)
    # 16 KB page alignment (required for Android 15+ devices with 16K pages).
    target_link_options(heif2jpeg PRIVATE "-Wl,-z,max-page-size=16384")
else()
    # Host build (for testing only): JNI headers from the local JDK.
    find_package(JNI REQUIRED)
    target_include_directories(heif2jpeg PRIVATE ${JNI_INCLUDE_DIRS})
    find_package(Threads REQUIRED)
    target_link_libraries(heif2jpeg heif_static de265_static Threads::Threads)
endif()
