#pragma once

#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

// A decoded, display-oriented RGB image plus the metadata to carry over.
struct DecodedImage {
    const uint8_t* data = nullptr;  // interleaved RGB
    int width = 0;
    int height = 0;
    int stride = 0;                 // bytes per row
    int bytesPerSample = 1;         // 1 or 2 (native-endian uint16)
    int bitDepth = 8;               // significant bits per sample
    std::shared_ptr<void> owner;    // keeps `data` alive

    std::vector<uint8_t> exifTiff;  // TIFF structure (no "Exif\0\0" prefix); Orientation already normalised
    std::vector<uint8_t> xmp;
    std::vector<uint8_t> icc;       // embedded ICC profile, if any

    // Colour signalling when there is no ICC profile (ISO/IEC 23091-2 codes).
    int nclxPrimaries = 1;          // 1 = BT.709/sRGB
    int nclxTransfer = 13;          // 13 = sRGB

    std::string warnings;           // notes for JPEG output (HDR, gamut ...)
};

std::string decodeHeif(const uint8_t* data, size_t len, DecodedImage& out);
std::string decodeRaw(const uint8_t* data, size_t len, DecodedImage& out);

struct OutputOptions {
    int quality = 100;
    bool subsample420 = false;
    bool keepMetadata = true;
};

std::string writeJpeg(const DecodedImage& img, const OutputOptions& opt, FILE* out);
std::string writeAvif(const DecodedImage& img, const OutputOptions& opt, FILE* out);
