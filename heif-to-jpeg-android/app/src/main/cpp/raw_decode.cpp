// Camera RAW (Sony .ARW etc.) decoding via LibRaw into a DecodedImage.

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <memory>
#include <string>
#include <vector>

#include <libraw/libraw.h>

#include "image.h"

namespace {

// ---- Tiny TIFF/EXIF writer (little endian) ----------------------------------
// RAW files keep EXIF inside their own TIFF structure, which can't be dropped
// into a JPEG as-is, so we rebuild the important tags from what LibRaw parsed.

enum : uint16_t { kByte = 1, kAscii = 2, kShort = 3, kLong = 4, kRational = 5 };

struct Entry {
    uint16_t tag, type;
    uint32_t count;
    std::vector<uint8_t> data;  // raw value bytes (little endian)
};

void put16(std::vector<uint8_t>& v, uint32_t x) { v.push_back(x & 0xff); v.push_back((x >> 8) & 0xff); }
void put32(std::vector<uint8_t>& v, uint32_t x) { for (int i = 0; i < 4; ++i) v.push_back((x >> (8 * i)) & 0xff); }

Entry ascii(uint16_t tag, const std::string& s) {
    Entry e{tag, kAscii, (uint32_t)s.size() + 1, {}};
    e.data.assign(s.begin(), s.end());
    e.data.push_back(0);
    return e;
}
Entry shortVal(uint16_t tag, uint16_t v) { Entry e{tag, kShort, 1, {}}; put16(e.data, v); return e; }
Entry longVal(uint16_t tag, uint32_t v) { Entry e{tag, kLong, 1, {}}; put32(e.data, v); return e; }
Entry byteVals(uint16_t tag, std::vector<uint8_t> b) { Entry e{tag, kByte, (uint32_t)b.size(), std::move(b)}; return e; }
Entry rationals(uint16_t tag, const std::vector<std::pair<uint32_t, uint32_t>>& r) {
    Entry e{tag, kRational, (uint32_t)r.size(), {}};
    for (auto& p : r) { put32(e.data, p.first); put32(e.data, p.second); }
    return e;
}
std::pair<uint32_t, uint32_t> rat(double v, uint32_t den = 10000) {
    if (v < 0) v = 0;
    return {(uint32_t)std::lround(v * den), den};
}

size_t ifdSize(const std::vector<Entry>& es) {
    size_t s = 2 + es.size() * 12 + 4;
    for (auto& e : es) if (e.data.size() > 4) s += (e.data.size() + 1) & ~size_t(1);
    return s;
}

// Serialises an IFD that will live at absolute TIFF offset `base`.
void writeIfd(std::vector<uint8_t>& out, const std::vector<Entry>& es, uint32_t base) {
    std::vector<uint8_t> extra;
    uint32_t dataOff = base + 2 + es.size() * 12 + 4;
    put16(out, (uint32_t)es.size());
    for (auto& e : es) {
        put16(out, e.tag);
        put16(out, e.type);
        put32(out, e.count);
        if (e.data.size() <= 4) {
            std::vector<uint8_t> v = e.data;
            v.resize(4, 0);
            out.insert(out.end(), v.begin(), v.end());
        } else {
            put32(out, dataOff + (uint32_t)extra.size());
            extra.insert(extra.end(), e.data.begin(), e.data.end());
            if (extra.size() & 1) extra.push_back(0);
        }
    }
    put32(out, 0);  // no next IFD
    out.insert(out.end(), extra.begin(), extra.end());
}

std::string trimmed(const char* s) {
    std::string r(s);
    while (!r.empty() && (r.back() == ' ' || r.back() == '\0')) r.pop_back();
    return r;
}

std::vector<uint8_t> buildExif(const libraw_data_t& d, int width, int height) {
    char dt[32] = "";
    if (d.other.timestamp > 0) {
        time_t t = d.other.timestamp;
        struct tm tmv;
        localtime_r(&t, &tmv);
        strftime(dt, sizeof dt, "%Y:%m:%d %H:%M:%S", &tmv);
    }

    std::vector<Entry> ifd0, exif, gps;
    if (d.idata.make[0]) ifd0.push_back(ascii(0x010F, trimmed(d.idata.make)));
    if (d.idata.model[0]) ifd0.push_back(ascii(0x0110, trimmed(d.idata.model)));
    ifd0.push_back(shortVal(0x0112, 1));  // pixels are already rotated
    ifd0.push_back(ascii(0x0131, "HEIF to JPEG (LibRaw)"));
    if (dt[0]) ifd0.push_back(ascii(0x0132, dt));
    ifd0.push_back(longVal(0x8769, 0));  // Exif IFD pointer, patched below

    float sh = d.other.shutter;
    if (sh > 0) {
        if (sh < 1) {
            uint32_t den = (uint32_t)std::lround(1.0 / sh);
            if (den > 0 && std::fabs(1.0 / den - sh) / sh < 0.01) exif.push_back(rationals(0x829A, {{1, den}}));
            else exif.push_back(rationals(0x829A, {rat(sh, 1000000)}));
        } else {
            exif.push_back(rationals(0x829A, {rat(sh, 10)}));
        }
    }
    if (d.other.aperture > 0) exif.push_back(rationals(0x829D, {rat(d.other.aperture, 10)}));
    if (d.other.iso_speed > 0) exif.push_back(shortVal(0x8827, (uint16_t)std::min(65535.0f, d.other.iso_speed)));
    if (dt[0]) exif.push_back(ascii(0x9003, dt));
    if (d.other.focal_len > 0) exif.push_back(rationals(0x920A, {rat(d.other.focal_len, 10)}));
    exif.push_back(longVal(0xA002, (uint32_t)width));
    exif.push_back(longVal(0xA003, (uint32_t)height));
    std::string lens = trimmed(d.lens.Lens);
    if (lens.empty()) lens = trimmed(d.lens.makernotes.Lens);
    if (!lens.empty()) exif.push_back(ascii(0xA434, lens));

    const libraw_gps_info_t& g = d.other.parsed_gps;
    if (g.gpsparsed && (g.latref == 'N' || g.latref == 'S') && (g.longref == 'E' || g.longref == 'W')) {
        ifd0.push_back(longVal(0x8825, 0));  // GPS IFD pointer, patched below
        gps.push_back(byteVals(0x0000, {2, 2, 0, 0}));
        gps.push_back(ascii(0x0001, std::string(1, g.latref)));
        gps.push_back(rationals(0x0002, {rat(g.latitude[0], 1), rat(g.latitude[1], 1), rat(g.latitude[2], 10000)}));
        gps.push_back(ascii(0x0003, std::string(1, g.longref)));
        gps.push_back(rationals(0x0004, {rat(g.longitude[0], 1), rat(g.longitude[1], 1), rat(g.longitude[2], 10000)}));
        gps.push_back(byteVals(0x0005, {(uint8_t)(g.altref ? 1 : 0)}));
        gps.push_back(rationals(0x0006, {rat(std::fabs(g.altitude), 100)}));
    }

    const uint32_t ifd0Off = 8;
    const uint32_t exifOff = ifd0Off + (uint32_t)ifdSize(ifd0);
    const uint32_t gpsOff = exifOff + (uint32_t)ifdSize(exif);
    for (auto& e : ifd0) {
        if (e.tag == 0x8769) { e.data.clear(); put32(e.data, exifOff); }
        if (e.tag == 0x8825) { e.data.clear(); put32(e.data, gpsOff); }
    }

    std::vector<uint8_t> tiff = {'I', 'I', 42, 0};
    put32(tiff, ifd0Off);
    writeIfd(tiff, ifd0, ifd0Off);
    writeIfd(tiff, exif, exifOff);
    if (!gps.empty()) writeIfd(tiff, gps, gpsOff);

    return tiff;
}

}  // namespace

// Develops a camera RAW file into 16-bit sRGB.
// Returns "" on success or an error message.
std::string decodeRaw(const uint8_t* data, size_t len, DecodedImage& out) {
    std::unique_ptr<LibRaw> raw(new LibRaw(0));
    libraw_output_params_t& p = raw->imgdata.params;
    p.output_bps = 16;      // keep full precision until the encoder
    p.use_camera_wb = 1;    // white balance as shot
    p.output_color = 1;     // sRGB
    p.user_qual = 3;        // AHD demosaicing
    p.highlight = 0;        // clip highlights (like the camera)

    int rc = raw->open_buffer(data, len);
    if (rc != LIBRAW_SUCCESS) return std::string("Not a readable RAW file: ") + libraw_strerror(rc);
    rc = raw->unpack();
    if (rc != LIBRAW_SUCCESS) return std::string("RAW unpack failed: ") + libraw_strerror(rc);
    rc = raw->dcraw_process();
    if (rc != LIBRAW_SUCCESS) return std::string("RAW processing failed: ") + libraw_strerror(rc);

    int err = 0;
    libraw_processed_image_t* mem = raw->dcraw_make_mem_image(&err);
    if (!mem || err != LIBRAW_SUCCESS) {
        if (mem) LibRaw::dcraw_clear_mem(mem);
        return std::string("RAW output failed: ") + libraw_strerror(err);
    }
    std::shared_ptr<libraw_processed_image_t> img(mem, [](libraw_processed_image_t* m) { LibRaw::dcraw_clear_mem(m); });
    if (img->type != LIBRAW_IMAGE_BITMAP || img->colors != 3 || img->bits != 16)
        return "Unexpected RAW output format";

    out.width = img->width;
    out.height = img->height;
    out.stride = img->width * 3 * 2;
    out.bytesPerSample = 2;
    out.bitDepth = 16;
    out.data = img->data;
    out.owner = img;
    out.exifTiff = buildExif(raw->imgdata, out.width, out.height);
    return "";
}
