cmake_minimum_required(VERSION 3.22.1)
project(heif2jpeg C CXX)

# Native dependencies, all built from source:
#  * libheif + libde265: software HEVC decoding, so the app can read HEVC
#    "Main 4:2:2 10" camera files (Sony/Canon/Fujifilm .HIF) that most phone
#    hardware decoders reject
#  * libaom: AV1 encoding for AVIF output (through libheif)
#  * LibRaw: camera RAW (Sony .ARW)

include(ExternalProject)

set(LIBDE265_TAG v1.0.16)
set(LIBHEIF_TAG v1.20.2)
set(LIBAOM_TAG v3.12.1)

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

if(ANDROID AND ANDROID_ABI STREQUAL "arm64-v8a")
    set(AOM_CPU arm64)
elseif(ANDROID AND ANDROID_ABI STREQUAL "x86_64")
    set(AOM_CPU x86_64)
else()
    set(AOM_CPU generic)
endif()

ExternalProject_Add(libaom_ext
    GIT_REPOSITORY https://aomedia.googlesource.com/aom
    GIT_TAG ${LIBAOM_TAG}
    GIT_SHALLOW TRUE
    PREFIX ${DEPS_PREFIX}/libaom
    CMAKE_ARGS ${FORWARD_ARGS}
        -DAOM_TARGET_CPU=${AOM_CPU}
        -DCONFIG_AV1_DECODER=0
        -DCONFIG_PIC=1
        -DENABLE_DOCS=0
        -DENABLE_EXAMPLES=0
        -DENABLE_TESTDATA=0
        -DENABLE_TESTS=0
        -DENABLE_TOOLS=0
    BUILD_BYPRODUCTS ${DEPS_INSTALL}/lib/libaom.a
)

ExternalProject_Add(libheif_ext
    GIT_REPOSITORY https://github.com/strukturag/libheif.git
    GIT_TAG ${LIBHEIF_TAG}
    GIT_SHALLOW TRUE
    PREFIX ${DEPS_PREFIX}/libheif
    DEPENDS libde265_ext libaom_ext
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
        -DWITH_AOM_ENCODER=ON
        -DAOM_INCLUDE_DIR=${DEPS_INSTALL}/include
        -DAOM_LIBRARY=${DEPS_INSTALL}/lib/libaom.a
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

add_library(aom_static STATIC IMPORTED)
set_target_properties(aom_static PROPERTIES IMPORTED_LOCATION ${DEPS_INSTALL}/lib/libaom.a)
add_dependencies(aom_static libaom_ext)

add_library(heif_static STATIC IMPORTED)
set_target_properties(heif_static PROPERTIES
    IMPORTED_LOCATION ${DEPS_INSTALL}/lib/libheif.a
    INTERFACE_INCLUDE_DIRECTORIES ${DEPS_INSTALL}/include
    INTERFACE_COMPILE_DEFINITIONS LIBHEIF_STATIC_BUILD)
add_dependencies(heif_static libheif_ext)

# ---- LibRaw (camera RAW: Sony .ARW and others) -------------------------------
# LibRaw ships no CMake build, so fetch the sources and compile the same file
# list as its Makefile.dist.
include(FetchContent)
FetchContent_Declare(libraw
    GIT_REPOSITORY https://github.com/LibRaw/LibRaw.git
    GIT_TAG 0.22.3
    GIT_SHALLOW TRUE)
FetchContent_GetProperties(libraw)
if(NOT libraw_POPULATED)
    FetchContent_Populate(libraw)
endif()

set(LIBRAW_SRC_FILES
    src/decoders/canon_600.cpp src/decoders/crx.cpp src/decoders/decoders_dcraw.cpp
    src/decoders/decoders_libraw.cpp src/decoders/decoders_libraw_dcrdefs.cpp
    src/decoders/dng.cpp src/decoders/fp_dng.cpp src/decoders/fuji_compressed.cpp
    src/decoders/generic.cpp src/decoders/kodak_decoders.cpp src/decoders/load_mfbacks.cpp
    src/decoders/olympus14.cpp src/decoders/pana8.cpp src/decoders/smal.cpp
    src/decoders/sonycc.cpp src/decoders/unpack.cpp src/decoders/unpack_thumb.cpp
    src/decompressors/losslessjpeg.cpp
    src/demosaic/aahd_demosaic.cpp src/demosaic/ahd_demosaic.cpp src/demosaic/dcb_demosaic.cpp
    src/demosaic/dht_demosaic.cpp src/demosaic/misc_demosaic.cpp src/demosaic/xtrans_demosaic.cpp
    src/integration/dngsdk_glue.cpp src/integration/rawspeed_glue.cpp
    src/libraw_c_api.cpp src/libraw_datastream.cpp
    src/metadata/adobepano.cpp src/metadata/canon.cpp src/metadata/ciff.cpp
    src/metadata/cr3_parser.cpp src/metadata/epson.cpp src/metadata/exif_gps.cpp
    src/metadata/fuji.cpp src/metadata/hasselblad_model.cpp src/metadata/identify.cpp
    src/metadata/identify_tools.cpp src/metadata/kodak.cpp src/metadata/leica.cpp
    src/metadata/makernotes.cpp src/metadata/mediumformat.cpp src/metadata/minolta.cpp
    src/metadata/misc_parsers.cpp src/metadata/nikon.cpp src/metadata/normalize_model.cpp
    src/metadata/olympus.cpp src/metadata/p1.cpp src/metadata/pentax.cpp
    src/metadata/samsung.cpp src/metadata/sony.cpp src/metadata/tiff.cpp
    src/postprocessing/aspect_ratio.cpp src/postprocessing/dcraw_process.cpp
    src/postprocessing/mem_image.cpp src/postprocessing/postprocessing_aux.cpp
    src/postprocessing/postprocessing_utils.cpp src/postprocessing/postprocessing_utils_dcrdefs.cpp
    src/preprocessing/ext_preprocess.cpp src/preprocessing/raw2image.cpp
    src/preprocessing/subtract_black.cpp
    src/tables/cameralist.cpp src/tables/colorconst.cpp src/tables/colordata.cpp
    src/tables/wblists.cpp
    src/utils/curves.cpp src/utils/decoder_info.cpp src/utils/init_close_utils.cpp
    src/utils/open.cpp src/utils/phaseone_processing.cpp src/utils/read_utils.cpp
    src/utils/thumb_utils.cpp src/utils/utils_dcraw.cpp src/utils/utils_libraw.cpp
    src/write/apply_profile.cpp src/write/file_write.cpp src/write/tiff_writer.cpp
    src/x3f/x3f_parse_process.cpp src/x3f/x3f_utils_patched.cpp)
list(TRANSFORM LIBRAW_SRC_FILES PREPEND ${libraw_SOURCE_DIR}/)

add_library(raw_static STATIC ${LIBRAW_SRC_FILES})
target_include_directories(raw_static PUBLIC ${libraw_SOURCE_DIR})
target_compile_options(raw_static PRIVATE -O3 -w)
set_target_properties(raw_static PROPERTIES POSITION_INDEPENDENT_CODE ON)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(heif2jpeg SHARED jni_bridge.cpp heif_decode.cpp raw_decode.cpp writers.cpp jpeg_encoder.cpp)
target_compile_options(heif2jpeg PRIVATE -O3 -Wall)

if(ANDROID)
    target_link_libraries(heif2jpeg heif_static de265_static aom_static raw_static log)
    # 16 KB page alignment (required for Android 15+ devices with 16K pages).
    target_link_options(heif2jpeg PRIVATE "-Wl,-z,max-page-size=16384")
else()
    # Host build (for testing only): JNI headers from the local JDK.
    find_package(JNI REQUIRED)
    target_include_directories(heif2jpeg PRIVATE ${JNI_INCLUDE_DIRS})
    find_package(Threads REQUIRED)
    target_link_libraries(heif2jpeg heif_static de265_static aom_static raw_static Threads::Threads)
endif()
