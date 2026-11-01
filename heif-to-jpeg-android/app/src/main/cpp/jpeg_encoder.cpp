#include "jpeg_encoder.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace {

const uint8_t kZigzag[64] = {
    0,  1,  8,  16, 9,  2,  3,  10, 17, 24, 32, 25, 18, 11, 4,  5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6,  7,  14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63};

// Annex K base quantization tables (natural order).
const uint8_t kLumaQ[64] = {
    16, 11, 10, 16, 24,  40,  51,  61,  12, 12, 14, 19, 26,  58,  60,  55,
    14, 13, 16, 24, 40,  57,  69,  56,  14, 17, 22, 29, 51,  87,  80,  62,
    18, 22, 37, 56, 68,  109, 103, 77,  24, 35, 55, 64, 81,  104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99};
const uint8_t kChromaQ[64] = {
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99};

// Annex K standard Huffman tables.
const uint8_t kDcLumaBits[16] = {0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0};
const uint8_t kDcLumaVals[12] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
const uint8_t kDcChromaBits[16] = {0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0};
const uint8_t kDcChromaVals[12] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
const uint8_t kAcLumaBits[16] = {0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d};
const uint8_t kAcLumaVals[162] = {
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa};
const uint8_t kAcChromaBits[16] = {0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77};
const uint8_t kAcChromaVals[162] = {
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa};

struct HuffTable {
    uint16_t code[256];
    uint8_t size[256];
};

void buildHuff(const uint8_t bits[16], const uint8_t* vals, HuffTable& t) {
    std::memset(&t, 0, sizeof(t));
    uint16_t code = 0;
    int k = 0;
    for (int len = 1; len <= 16; ++len) {
        for (int i = 0; i < bits[len - 1]; ++i) {
            t.code[vals[k]] = code;
            t.size[vals[k]] = static_cast<uint8_t>(len);
            ++code;
            ++k;
        }
        code <<= 1;
    }
}

class Writer {
public:
    explicit Writer(FILE* f) : f_(f) { buf_.reserve(1 << 20); }
    bool ok() const { return ok_; }

    void byte(uint8_t b) {
        buf_.push_back(b);
        if (buf_.size() >= (1u << 20)) flush();
    }
    void word(uint16_t w) {
        byte(static_cast<uint8_t>(w >> 8));
        byte(static_cast<uint8_t>(w & 0xff));
    }
    void bytes(const uint8_t* p, size_t n) {
        for (size_t i = 0; i < n; ++i) byte(p[i]);
    }

    // Entropy-coded bits with 0xFF byte stuffing.
    void bits(uint32_t value, int count) {
        bitBuf_ = (bitBuf_ << count) | (value & ((1u << count) - 1));
        bitCnt_ += count;
        while (bitCnt_ >= 8) {
            uint8_t b = static_cast<uint8_t>(bitBuf_ >> (bitCnt_ - 8));
            byte(b);
            if (b == 0xff) byte(0);
            bitCnt_ -= 8;
        }
    }
    void padBits() {
        if (bitCnt_ > 0) bits(0x7f, 8 - bitCnt_);  // pad with 1-bits
        bitBuf_ = 0;
        bitCnt_ = 0;
    }

    void flush() {
        if (!buf_.empty()) {
            if (fwrite(buf_.data(), 1, buf_.size(), f_) != buf_.size()) ok_ = false;
            buf_.clear();
        }
    }

private:
    FILE* f_;
    std::vector<uint8_t> buf_;
    uint64_t bitBuf_ = 0;
    int bitCnt_ = 0;
    bool ok_ = true;
};

int bitLength(int v) {
    v = v < 0 ? -v : v;
    int n = 0;
    while (v) {
        ++n;
        v >>= 1;
    }
    return n;
}

void writeDHT(Writer& w, uint8_t cls_id, const uint8_t bits[16], const uint8_t* vals, int nvals) {
    w.word(0xFFC4);
    w.word(static_cast<uint16_t>(2 + 1 + 16 + nvals));
    w.byte(cls_id);
    w.bytes(bits, 16);
    w.bytes(vals, nvals);
}

struct Dct {
    float c[8][8];  // c[u][x] = C(u)/2 * cos((2x+1)u*pi/16)
    Dct() {
        for (int u = 0; u < 8; ++u)
            for (int x = 0; x < 8; ++x)
                c[u][x] = static_cast<float>((u == 0 ? std::sqrt(0.5) : 1.0) * 0.5 *
                                             std::cos((2 * x + 1) * u * M_PI / 16.0));
    }
    // in: 64 level-shifted samples (row major). out: 64 coefficients (natural order).
    void forward(const float* in, float* out) const {
        float tmp[64];
        for (int y = 0; y < 8; ++y)
            for (int u = 0; u < 8; ++u) {
                float s = 0;
                for (int x = 0; x < 8; ++x) s += c[u][x] * in[y * 8 + x];
                tmp[y * 8 + u] = s;
            }
        for (int v = 0; v < 8; ++v)
            for (int u = 0; u < 8; ++u) {
                float s = 0;
                for (int y = 0; y < 8; ++y) s += c[v][y] * tmp[y * 8 + u];
                out[v * 8 + u] = s;
            }
    }
};

void encodeBlock(Writer& w, const Dct& dct, const float* block, const uint8_t* q,
                 int& prevDc, const HuffTable& dc, const HuffTable& ac) {
    float coef[64];
    dct.forward(block, coef);

    int zz[64];
    for (int i = 0; i < 64; ++i) {
        int n = kZigzag[i];
        long v = std::lround(coef[n] / q[n]);
        if (i > 0) v = std::max(-1023L, std::min(1023L, v));
        else v = std::max(-2047L, std::min(2047L, v));
        zz[i] = static_cast<int>(v);
    }

    // DC
    int diff = zz[0] - prevDc;
    prevDc = zz[0];
    int nb = bitLength(diff);
    w.bits(dc.code[nb], dc.size[nb]);
    if (nb) w.bits(diff < 0 ? diff - 1 : diff, nb);

    // AC
    int run = 0;
    for (int i = 1; i < 64; ++i) {
        int v = zz[i];
        if (v == 0) {
            ++run;
            continue;
        }
        while (run > 15) {
            w.bits(ac.code[0xF0], ac.size[0xF0]);
            run -= 16;
        }
        nb = bitLength(v);
        int sym = (run << 4) | nb;
        w.bits(ac.code[sym], ac.size[sym]);
        w.bits(v < 0 ? v - 1 : v, nb);
        run = 0;
    }
    if (run > 0) w.bits(ac.code[0x00], ac.size[0x00]);
}

}  // namespace

std::string encodeJpeg(const JpegSource& src, int quality,
                       const std::vector<JpegMarker>& markers, FILE* out) {
    if (src.width <= 0 || src.height <= 0 || src.width > 65535 || src.height > 65535)
        return "Image dimensions not supported by JPEG";
    if (src.bytesPerSample != 1 && src.bytesPerSample != 2) return "Unsupported sample size";

    quality = std::max(1, std::min(100, quality));
    int scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
    uint8_t qY[64], qC[64];
    for (int i = 0; i < 64; ++i) {
        qY[i] = static_cast<uint8_t>(std::max(1, std::min(255, (kLumaQ[i] * scale + 50) / 100)));
        qC[i] = static_cast<uint8_t>(std::max(1, std::min(255, (kChromaQ[i] * scale + 50) / 100)));
    }

    HuffTable dcY, dcC, acY, acC;
    buildHuff(kDcLumaBits, kDcLumaVals, dcY);
    buildHuff(kDcChromaBits, kDcChromaVals, dcC);
    buildHuff(kAcLumaBits, kAcLumaVals, acY);
    buildHuff(kAcChromaBits, kAcChromaVals, acC);

    Writer w(out);
    w.word(0xFFD8);  // SOI

    bool hasExif = false;
    for (const auto& m : markers)
        if (m.marker == 0xE1 && m.payload.size() >= 6 && std::memcmp(m.payload.data(), "Exif\0\0", 6) == 0)
            hasExif = true;
    if (!hasExif) {
        static const uint8_t jfif[] = {'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0};
        w.word(0xFFE0);
        w.word(2 + sizeof(jfif));
        w.bytes(jfif, sizeof(jfif));
    }
    for (const auto& m : markers) {
        if (m.payload.size() > 65533) continue;
        w.byte(0xFF);
        w.byte(m.marker);
        w.word(static_cast<uint16_t>(m.payload.size() + 2));
        w.bytes(m.payload.data(), m.payload.size());
    }

    // DQT (zigzag order)
    w.word(0xFFDB);
    w.word(2 + 2 * 65);
    w.byte(0x00);
    for (int i = 0; i < 64; ++i) w.byte(qY[kZigzag[i]]);
    w.byte(0x01);
    for (int i = 0; i < 64; ++i) w.byte(qC[kZigzag[i]]);

    // SOF0, 3 components, all 1x1 sampling (4:4:4)
    w.word(0xFFC0);
    w.word(8 + 3 * 3);
    w.byte(8);
    w.word(static_cast<uint16_t>(src.height));
    w.word(static_cast<uint16_t>(src.width));
    w.byte(3);
    w.byte(1); w.byte(0x11); w.byte(0);
    w.byte(2); w.byte(0x11); w.byte(1);
    w.byte(3); w.byte(0x11); w.byte(1);

    writeDHT(w, 0x00, kDcLumaBits, kDcLumaVals, 12);
    writeDHT(w, 0x10, kAcLumaBits, kAcLumaVals, 162);
    writeDHT(w, 0x01, kDcChromaBits, kDcChromaVals, 12);
    writeDHT(w, 0x11, kAcChromaBits, kAcChromaVals, 162);

    // SOS
    w.word(0xFFDA);
    w.word(6 + 2 * 3);
    w.byte(3);
    w.byte(1); w.byte(0x00);
    w.byte(2); w.byte(0x11);
    w.byte(3); w.byte(0x11);
    w.byte(0); w.byte(63); w.byte(0);

    const Dct dct;
    const int bw = (src.width + 7) / 8;
    const int bh = (src.height + 7) / 8;
    const int pw = bw * 8;
    const float maxv = static_cast<float>((1 << src.bitDepth) - 1);
    const float toUnit = 255.0f / maxv;

    std::vector<float> Y(pw * 8), Cb(pw * 8), Cr(pw * 8);
    int prevY = 0, prevCb = 0, prevCr = 0;
    float blkY[64], blkCb[64], blkCr[64];

    for (int by = 0; by < bh; ++by) {
        // Convert one 8-row stripe to level-shifted YCbCr (JFIF / BT.601 full range).
        for (int r = 0; r < 8; ++r) {
            int sy = std::min(by * 8 + r, src.height - 1);
            const uint8_t* row = src.data + static_cast<size_t>(sy) * src.stride;
            for (int x = 0; x < pw; ++x) {
                int sx = std::min(x, src.width - 1);
                float R, G, B;
                if (src.bytesPerSample == 1) {
                    const uint8_t* p = row + sx * 3;
                    R = p[0]; G = p[1]; B = p[2];
                } else {
                    const uint16_t* p = reinterpret_cast<const uint16_t*>(row) + sx * 3;
                    R = p[0] * toUnit; G = p[1] * toUnit; B = p[2] * toUnit;
                }
                size_t o = static_cast<size_t>(r) * pw + x;
                Y[o] = 0.299f * R + 0.587f * G + 0.114f * B - 128.0f;
                Cb[o] = -0.168736f * R - 0.331264f * G + 0.5f * B;
                Cr[o] = 0.5f * R - 0.418688f * G - 0.081312f * B;
            }
        }
        for (int bx = 0; bx < bw; ++bx) {
            for (int r = 0; r < 8; ++r) {
                const size_t o = static_cast<size_t>(r) * pw + bx * 8;
                std::memcpy(blkY + r * 8, &Y[o], 8 * sizeof(float));
                std::memcpy(blkCb + r * 8, &Cb[o], 8 * sizeof(float));
                std::memcpy(blkCr + r * 8, &Cr[o], 8 * sizeof(float));
            }
            encodeBlock(w, dct, blkY, qY, prevY, dcY, acY);
            encodeBlock(w, dct, blkCb, qC, prevCb, dcC, acC);
            encodeBlock(w, dct, blkCr, qC, prevCr, dcC, acC);
        }
    }
    w.padBits();
    w.word(0xFFD9);  // EOI
    w.flush();
    if (!w.ok()) return "Failed writing output file (disk full?)";
    return "";
}
