#pragma once

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

// Minimal baseline JPEG encoder tuned for maximum fidelity:
//  * 4:4:4 sampling (no chroma subsampling at all)
//  * quality 100 => every quantization step is 1 (the lowest JPEG allows)
//  * input samples are fed as floats, so 10/12-bit sources are not rounded to
//    8 bits before the DCT.
struct JpegSource {
    const uint8_t* data;   // interleaved RGB rows
    int width;
    int height;
    int stride;            // bytes per row
    int bytesPerSample;    // 1 (8-bit) or 2 (16-bit little/native endian container)
    int bitDepth;          // significant bits per sample (8, 10, 12 ...)
};

struct JpegMarker {
    uint8_t marker;              // e.g. 0xE1 for APP1
    std::vector<uint8_t> payload; // segment payload without marker/length
};

// Returns empty string on success, otherwise an error message.
std::string encodeJpeg(const JpegSource& src, int quality,
                       const std::vector<JpegMarker>& markers, FILE* out);
