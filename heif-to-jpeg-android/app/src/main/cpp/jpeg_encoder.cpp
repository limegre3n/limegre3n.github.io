#include "jpeg_encoder.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <functional>
#include <thread>

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

struct HuffSpec {
    uint8_t bits[16];
    uint8_t vals[256];
    int nvals;
};

struct HuffTable {
    uint16_t code[256];
    uint8_t size[256];
};

void buildHuff(const HuffSpec& s, HuffTable& t) {
    std::memset(&t, 0, sizeof(t));
    uint16_t code = 0;
    int k = 0;
    for (int len = 1; len <= 16; ++len) {
        for (int i = 0; i < s.bits[len - 1]; ++i) {
            t.code[s.vals[k]] = code;
            t.size[s.vals[k]] = static_cast<uint8_t>(len);
            ++code;
            ++k;
        }
        code <<= 1;
    }
}

// Optimal length-limited Huffman table from symbol frequencies
// (the algorithm of JPEG Annex K.2, as in IJG jchuff.c).
void optimalTable(const long freqIn[256], HuffSpec& out) {
    long freq[257];
    int codesize[257], others[257];
    for (int i = 0; i < 256; ++i) freq[i] = freqIn[i];
    freq[256] = 1;  // reserved: guarantees no code of all 1-bits
    for (int i = 0; i < 257; ++i) { codesize[i] = 0; others[i] = -1; }

    for (;;) {
        int c1 = -1, c2 = -1;
        long v = 1000000000L;
        for (int i = 0; i <= 256; ++i)
            if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i; }
        v = 1000000000L;
        for (int i = 0; i <= 256; ++i)
            if (freq[i] && freq[i] <= v && i != c1) { v = freq[i]; c2 = i; }
        if (c2 < 0) break;
        freq[c1] += freq[c2];
        freq[c2] = 0;
        ++codesize[c1];
        while (others[c1] >= 0) { c1 = others[c1]; ++codesize[c1]; }
        others[c1] = c2;
        ++codesize[c2];
        while (others[c2] >= 0) { c2 = others[c2]; ++codesize[c2]; }
    }

    int bits[33] = {0};
    for (int i = 0; i <= 256; ++i)
        if (codesize[i]) bits[std::min(codesize[i], 32)]++;
    for (int i = 32; i > 16; --i) {
        while (bits[i] > 0) {
            int j = i - 2;
            while (bits[j] == 0) --j;
            bits[i] -= 2;
            bits[i - 1]++;
            bits[j + 1] += 2;
            bits[j]--;
        }
    }
    int i = 16;
    while (bits[i] == 0) --i;
    bits[i]--;  // remove the reserved symbol

    for (int k = 0; k < 16; ++k) out.bits[k] = static_cast<uint8_t>(bits[k + 1]);
    int p = 0;
    for (int len = 1; len <= 32; ++len)
        for (int s = 0; s < 256; ++s)
            if (codesize[s] == len) out.vals[p++] = static_cast<uint8_t>(s);
    out.nvals = p;
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

inline int bitLength(int v) {
    v = v < 0 ? -v : v;
    int n = 0;
    while (v) { ++n; v >>= 1; }
    return n;
}

void writeDHT(Writer& w, uint8_t clsId, const HuffSpec& s) {
    w.word(0xFFC4);
    w.word(static_cast<uint16_t>(2 + 1 + 16 + s.nvals));
    w.byte(clsId);
    w.bytes(s.bits, 16);
    w.bytes(s.vals, s.nvals);
}

// AAN float forward DCT (as IJG jfdctflt.c). Output is scaled; the scale is
// folded into the quantization divisors.
void fdct(float* d) {
    for (int pass = 0; pass < 2; ++pass) {
        for (int i = 0; i < 8; ++i) {
            float* p = pass == 0 ? d + i * 8 : d + i;
            const int s = pass == 0 ? 1 : 8;
            float t0 = p[0] + p[7 * s], t7 = p[0] - p[7 * s];
            float t1 = p[1 * s] + p[6 * s], t6 = p[1 * s] - p[6 * s];
            float t2 = p[2 * s] + p[5 * s], t5 = p[2 * s] - p[5 * s];
            float t3 = p[3 * s] + p[4 * s], t4 = p[3 * s] - p[4 * s];

            float t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
            p[0] = t10 + t11;
            p[4 * s] = t10 - t11;
            float z1 = (t12 + t13) * 0.707106781f;
            p[2 * s] = t13 + z1;
            p[6 * s] = t13 - z1;

            t10 = t4 + t5;
            t11 = t5 + t6;
            t12 = t6 + t7;
            float z5 = (t10 - t12) * 0.382683433f;
            float z2 = 0.541196100f * t10 + z5;
            float z4 = 1.306562965f * t12 + z5;
            float z3 = t11 * 0.707106781f;
            float z11 = t7 + z3, z13 = t7 - z3;
            p[5 * s] = z13 + z2;
            p[3 * s] = z13 - z2;
            p[1 * s] = z11 + z4;
            p[7 * s] = z11 - z4;
        }
    }
}

struct Layout {
    int mcuW, mcuH, mcusX, mcusY, blocksPerMcu;
    int comp[6];  // component of each block in an MCU
};

struct Ctx {
    const JpegSource* src;
    Layout L;
    float invY[64], invC[64];  // 1 / (q * aan scale), natural order
};

// Converts one MCU row to quantized zigzag coefficients.
void computeMcuRow(const Ctx& c, int my, int16_t* out) {
    const JpegSource& s = *c.src;
    const Layout& L = c.L;
    const int padW = L.mcusX * L.mcuW;
    const int rows = L.mcuH;
    std::vector<float> Y(static_cast<size_t>(padW) * rows), Cb(Y.size()), Cr(Y.size());
    const float toUnit = 255.0f / static_cast<float>((1u << s.bitDepth) - 1);

    for (int r = 0; r < rows; ++r) {
        int sy = std::min(my * rows + r, s.height - 1);
        const uint8_t* row = s.data + static_cast<size_t>(sy) * s.stride;
        float* y = &Y[static_cast<size_t>(r) * padW];
        float* cb = &Cb[static_cast<size_t>(r) * padW];
        float* cr = &Cr[static_cast<size_t>(r) * padW];
        for (int x = 0; x < padW; ++x) {
            int sx = std::min(x, s.width - 1);
            float R, G, B;
            if (s.bytesPerSample == 1) {
                const uint8_t* p = row + sx * 3;
                R = p[0]; G = p[1]; B = p[2];
            } else {
                const uint16_t* p = reinterpret_cast<const uint16_t*>(row) + sx * 3;
                R = p[0] * toUnit; G = p[1] * toUnit; B = p[2] * toUnit;
            }
            y[x] = 0.299f * R + 0.587f * G + 0.114f * B - 128.0f;
            cb[x] = -0.168736f * R - 0.331264f * G + 0.5f * B;
            cr[x] = 0.5f * R - 0.418688f * G - 0.081312f * B;
        }
    }

    // 4:2:0: average 2x2 chroma into the top-left quarter of the buffers.
    const int chromaW = L.mcuW == 16 ? padW / 2 : padW;
    if (L.mcuW == 16) {
        for (int r = 0; r < 8; ++r)
            for (int x = 0; x < chromaW; ++x) {
                size_t a = static_cast<size_t>(2 * r) * padW + 2 * x, b = a + padW;
                Cb[static_cast<size_t>(r) * chromaW + x] = 0.25f * (Cb[a] + Cb[a + 1] + Cb[b] + Cb[b + 1]);
                Cr[static_cast<size_t>(r) * chromaW + x] = 0.25f * (Cr[a] + Cr[a + 1] + Cr[b] + Cr[b + 1]);
            }
    }

    float blk[64];
    int16_t* o = out;
    auto emit = [&](const std::vector<float>& plane, int stride, int x0, int y0, const float* inv) {
        for (int r = 0; r < 8; ++r)
            std::memcpy(blk + r * 8, &plane[static_cast<size_t>(y0 + r) * stride + x0], 8 * sizeof(float));
        fdct(blk);
        for (int i = 0; i < 64; ++i) {
            int n = kZigzag[i];
            float v = blk[n] * inv[n];
            int q = static_cast<int>(v + (v >= 0 ? 0.5f : -0.5f));
            q = i == 0 ? std::max(-2047, std::min(2047, q)) : std::max(-1023, std::min(1023, q));
            o[i] = static_cast<int16_t>(q);
        }
        o += 64;
    };

    for (int mx = 0; mx < L.mcusX; ++mx) {
        if (L.mcuW == 8) {
            emit(Y, padW, mx * 8, 0, c.invY);
            emit(Cb, padW, mx * 8, 0, c.invC);
            emit(Cr, padW, mx * 8, 0, c.invC);
        } else {
            emit(Y, padW, mx * 16, 0, c.invY);
            emit(Y, padW, mx * 16 + 8, 0, c.invY);
            emit(Y, padW, mx * 16, 8, c.invY);
            emit(Y, padW, mx * 16 + 8, 8, c.invY);
            emit(Cb, chromaW, mx * 8, 0, c.invC);
            emit(Cr, chromaW, mx * 8, 0, c.invC);
        }
    }
}

// Runs the DCT over the whole image in parallel batches of MCU rows and feeds
// every block, in file order, to `consume(block, component)`.
void runPass(const Ctx& c, int threads, const std::function<void(const int16_t*, int)>& consume) {
    const Layout& L = c.L;
    const size_t rowCoefs = static_cast<size_t>(L.mcusX) * L.blocksPerMcu * 64;
    const int batch = std::max(1, threads * 2);
    std::vector<int16_t> buf(rowCoefs * batch);

    for (int my0 = 0; my0 < L.mcusY; my0 += batch) {
        int n = std::min(batch, L.mcusY - my0);
        if (threads <= 1 || n == 1) {
            for (int k = 0; k < n; ++k) computeMcuRow(c, my0 + k, &buf[rowCoefs * k]);
        } else {
            std::vector<std::thread> pool;
            int t = std::min(threads, n);
            for (int ti = 0; ti < t; ++ti)
                pool.emplace_back([&, ti]() {
                    for (int k = ti; k < n; k += t) computeMcuRow(c, my0 + k, &buf[rowCoefs * k]);
                });
            for (auto& th : pool) th.join();
        }
        for (int k = 0; k < n; ++k) {
            const int16_t* blk = &buf[rowCoefs * k];
            for (int mx = 0; mx < L.mcusX; ++mx)
                for (int b = 0; b < L.blocksPerMcu; ++b, blk += 64) consume(blk, L.comp[b]);
        }
    }
}

}  // namespace

std::string encodeJpeg(const JpegSource& src, const JpegOptions& opt,
                       const std::vector<JpegMarker>& markers, FILE* out) {
    if (src.width <= 0 || src.height <= 0 || src.width > 65535 || src.height > 65535)
        return "Image dimensions not supported by JPEG";
    if (src.bytesPerSample != 1 && src.bytesPerSample != 2) return "Unsupported sample size";

    const int quality = std::max(1, std::min(100, opt.quality));
    const int scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
    uint8_t qY[64], qC[64];
    for (int i = 0; i < 64; ++i) {
        qY[i] = static_cast<uint8_t>(std::max(1, std::min(255, (kLumaQ[i] * scale + 50) / 100)));
        qC[i] = static_cast<uint8_t>(std::max(1, std::min(255, (kChromaQ[i] * scale + 50) / 100)));
    }

    Ctx c;
    c.src = &src;
    Layout& L = c.L;
    if (opt.subsample420) {
        L = {16, 16, (src.width + 15) / 16, (src.height + 15) / 16, 6, {0, 0, 0, 0, 1, 2}};
    } else {
        L = {8, 8, (src.width + 7) / 8, (src.height + 7) / 8, 3, {0, 1, 2, 0, 0, 0}};
    }
    double aan[8];
    for (int k = 0; k < 8; ++k) aan[k] = k == 0 ? 1.0 : std::cos(k * M_PI / 16.0) * std::sqrt(2.0);
    for (int v = 0; v < 8; ++v)
        for (int u = 0; u < 8; ++u) {
            double s = aan[v] * aan[u] * 8.0;
            c.invY[v * 8 + u] = static_cast<float>(1.0 / (qY[v * 8 + u] * s));
            c.invC[v * 8 + u] = static_cast<float>(1.0 / (qC[v * 8 + u] * s));
        }

    int threads = opt.threads > 0 ? opt.threads : static_cast<int>(std::thread::hardware_concurrency());
    threads = std::max(1, std::min(threads, 8));

    // Pass 1: symbol statistics for optimal Huffman tables.
    long dcFreq[2][256] = {{0}}, acFreq[2][256] = {{0}};
    {
        int prev[3] = {0, 0, 0};
        runPass(c, threads, [&](const int16_t* z, int comp) {
            const int t = comp == 0 ? 0 : 1;
            int diff = z[0] - prev[comp];
            prev[comp] = z[0];
            dcFreq[t][bitLength(diff)]++;
            int run = 0;
            for (int i = 1; i < 64; ++i) {
                if (z[i] == 0) { ++run; continue; }
                while (run > 15) { acFreq[t][0xF0]++; run -= 16; }
                acFreq[t][(run << 4) | bitLength(z[i])]++;
                run = 0;
            }
            if (run > 0) acFreq[t][0x00]++;
        });
    }
    HuffSpec specs[4];  // DC0, AC0, DC1, AC1
    optimalTable(dcFreq[0], specs[0]);
    optimalTable(acFreq[0], specs[1]);
    optimalTable(dcFreq[1], specs[2]);
    optimalTable(acFreq[1], specs[3]);
    HuffTable dc[2], ac[2];
    buildHuff(specs[0], dc[0]);
    buildHuff(specs[1], ac[0]);
    buildHuff(specs[2], dc[1]);
    buildHuff(specs[3], ac[1]);

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

    // SOF0
    w.word(0xFFC0);
    w.word(8 + 3 * 3);
    w.byte(8);
    w.word(static_cast<uint16_t>(src.height));
    w.word(static_cast<uint16_t>(src.width));
    w.byte(3);
    w.byte(1); w.byte(opt.subsample420 ? 0x22 : 0x11); w.byte(0);
    w.byte(2); w.byte(0x11); w.byte(1);
    w.byte(3); w.byte(0x11); w.byte(1);

    writeDHT(w, 0x00, specs[0]);
    writeDHT(w, 0x10, specs[1]);
    writeDHT(w, 0x01, specs[2]);
    writeDHT(w, 0x11, specs[3]);

    // SOS
    w.word(0xFFDA);
    w.word(6 + 2 * 3);
    w.byte(3);
    w.byte(1); w.byte(0x00);
    w.byte(2); w.byte(0x11);
    w.byte(3); w.byte(0x11);
    w.byte(0); w.byte(63); w.byte(0);

    // Pass 2: entropy-code.
    {
        int prev[3] = {0, 0, 0};
        runPass(c, threads, [&](const int16_t* z, int comp) {
            const int t = comp == 0 ? 0 : 1;
            const HuffTable& D = dc[t];
            const HuffTable& A = ac[t];
            int diff = z[0] - prev[comp];
            prev[comp] = z[0];
            int nb = bitLength(diff);
            w.bits(D.code[nb], D.size[nb]);
            if (nb) w.bits(diff < 0 ? diff - 1 : diff, nb);
            int run = 0;
            for (int i = 1; i < 64; ++i) {
                int v = z[i];
                if (v == 0) { ++run; continue; }
                while (run > 15) { w.bits(A.code[0xF0], A.size[0xF0]); run -= 16; }
                nb = bitLength(v);
                int sym = (run << 4) | nb;
                w.bits(A.code[sym], A.size[sym]);
                w.bits(v < 0 ? v - 1 : v, nb);
                run = 0;
            }
            if (run > 0) w.bits(A.code[0x00], A.size[0x00]);
        });
    }
    w.padBits();
    w.word(0xFFD9);  // EOI
    w.flush();
    if (!w.ok()) return "Failed writing output file (disk full?)";
    return "";
}
