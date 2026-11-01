#pragma once

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

// Baseline JPEG encoder tuned for fidelity and size:
//  * 4:4:4 (no chroma subsampling) or 4:2:0
//  * standard IJG quality scaling (100 => every quantization step is 1)
//  * optimized Huffman tables (two passes; lossless size saving)
//  * input samples are fed as floats, so 10/12/16-bit sources are not rounded
//    to 8 bits before the DCT
//  * multithreaded DCT/quantization
struct JpegSource {
    const uint8_t* data;   // interleaved RGB rows
    int width;
    int height;
    int stride;            // bytes per row
    int bytesPerSample;    // 1 (8-bit) or 2 (16-bit native-endian container)
    int bitDepth;          // significant bits per sample (8, 10, 12, 16 ...)
};

struct JpegMarker {
    uint8_t marker;               // e.g. 0xE1 for APP1
    std::vector<uint8_t> payload; // segment payload without marker/length
};

struct JpegOptions {
    int quality = 100;
    bool subsample420 = false;
    int threads = 0;  // 0 = hardware concurrency
};

// Returns empty string on success, otherwise an error message.
std::string encodeJpeg(const JpegSource& src, const JpegOptions& opt,
                       const std::vector<JpegMarker>& markers, FILE* out);
