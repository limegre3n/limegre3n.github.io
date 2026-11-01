// HEIF -> JPEG conversion core + JNI bridge (RAW files are handed to raw2jpeg.cpp).

#include <jni.h>
#include <unistd.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <libheif/heif.h>

#include "jpeg_encoder.h"

#ifdef __ANDROID__
#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "heif2jpeg", __VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#endif

namespace {

struct CtxDeleter { void operator()(heif_context* c) const { heif_context_free(c); } };
struct HandleDeleter { void operator()(heif_image_handle* h) const { heif_image_handle_release(h); } };
struct ImageDeleter { void operator()(heif_image* i) const { heif_image_release(i); } };
struct OptionsDeleter { void operator()(heif_decoding_options* o) const { heif_decoding_options_free(o); } };

// ---- Minimal TIFF/EXIF patching ---------------------------------------------
// libheif applies the HEIF rotation/mirror boxes to the pixels, so the JPEG must
// say "Orientation = normal" or viewers would rotate the image a second time.

struct Tiff {
    uint8_t* p;
    size_t n;
    bool le;
    bool in(size_t off, size_t len) const { return off <= n && len <= n - off; }
    uint16_t u16(size_t o) const { return le ? (p[o] | p[o + 1] << 8) : (p[o] << 8 | p[o + 1]); }
    uint32_t u32(size_t o) const {
        return le ? (uint32_t)p[o] | (uint32_t)p[o + 1] << 8 | (uint32_t)p[o + 2] << 16 | (uint32_t)p[o + 3] << 24
                  : (uint32_t)p[o] << 24 | (uint32_t)p[o + 1] << 16 | (uint32_t)p[o + 2] << 8 | (uint32_t)p[o + 3];
    }
    void w16(size_t o, uint16_t v) {
        if (le) { p[o] = v & 0xff; p[o + 1] = v >> 8; } else { p[o] = v >> 8; p[o + 1] = v & 0xff; }
    }
    void w32(size_t o, uint32_t v) {
        if (le) { for (int i = 0; i < 4; ++i) p[o + i] = (v >> (8 * i)) & 0xff; }
        else { for (int i = 0; i < 4; ++i) p[o + i] = (v >> (24 - 8 * i)) & 0xff; }
    }
};

void patchIfd(Tiff& t, uint32_t ifd, int width, int height, bool top) {
    if (!t.in(ifd, 2)) return;
    uint16_t count = t.u16(ifd);
    if (!t.in(ifd + 2, (size_t)count * 12)) return;
    for (uint16_t i = 0; i < count; ++i) {
        size_t e = ifd + 2 + (size_t)i * 12;
        uint16_t tag = t.u16(e), type = t.u16(e + 2);
        if (top && tag == 0x0112 && type == 3) {
            t.w16(e + 8, 1);  // Orientation: normal
        } else if (top && tag == 0x8769 && type == 4) {
            patchIfd(t, t.u32(e + 8), width, height, false);  // Exif sub-IFD
        } else if (!top && (tag == 0xA002 || tag == 0xA003)) {
            uint32_t v = tag == 0xA002 ? width : height;
            if (type == 3) t.w16(e + 8, (uint16_t)v);
            else if (type == 4) t.w32(e + 8, v);
        }
    }
}

void patchExif(std::vector<uint8_t>& tiff, int width, int height) {
    if (tiff.size() < 8) return;
    Tiff t{tiff.data(), tiff.size(), tiff[0] == 'I'};
    if (!((tiff[0] == 'I' && tiff[1] == 'I') || (tiff[0] == 'M' && tiff[1] == 'M'))) return;
    if (t.u16(2) != 42) return;
    patchIfd(t, t.u32(4), width, height, true);
}

void collectMetadata(heif_image_handle* h, int outW, int outH, std::vector<JpegMarker>& markers,
                     std::string& warnings) {
    // EXIF -> APP1 "Exif\0\0" + TIFF
    int nExif = heif_image_handle_get_number_of_metadata_blocks(h, "Exif");
    if (nExif > 0) {
        heif_item_id id;
        heif_image_handle_get_list_of_metadata_block_IDs(h, "Exif", &id, 1);
        size_t sz = heif_image_handle_get_metadata_size(h, id);
        std::vector<uint8_t> raw(sz);
        if (sz > 4 && heif_image_handle_get_metadata(h, id, raw.data()).code == heif_error_Ok) {
            uint32_t off = (uint32_t)raw[0] << 24 | (uint32_t)raw[1] << 16 | (uint32_t)raw[2] << 8 | raw[3];
            size_t start = 4 + (size_t)off;
            // Some writers include "Exif\0\0" before the TIFF header; skip it.
            if (start + 6 <= sz && std::memcmp(&raw[start], "Exif\0\0", 6) == 0) start += 6;
            if (start < sz) {
                std::vector<uint8_t> tiff(raw.begin() + start, raw.end());
                patchExif(tiff, outW, outH);
                JpegMarker m{0xE1, {}};
                const uint8_t hdr[6] = {'E', 'x', 'i', 'f', 0, 0};
                m.payload.insert(m.payload.end(), hdr, hdr + 6);
                m.payload.insert(m.payload.end(), tiff.begin(), tiff.end());
                if (m.payload.size() <= 65533) markers.push_back(std::move(m));
                else warnings += "EXIF block too large for JPEG (>64 KB), not copied. ";
            }
        }
    }

    // ICC profile -> APP2 "ICC_PROFILE\0" chunks
    heif_color_profile_type cpt = heif_image_handle_get_color_profile_type(h);
    if (cpt == heif_color_profile_type_prof || cpt == heif_color_profile_type_rICC) {
        size_t sz = heif_image_handle_get_raw_color_profile_size(h);
        std::vector<uint8_t> icc(sz);
        if (sz > 0 && heif_image_handle_get_raw_color_profile(h, icc.data()).code == heif_error_Ok) {
            const size_t chunk = 65519;
            size_t chunks = (sz + chunk - 1) / chunk;
            if (chunks <= 255) {
                for (size_t c = 0; c < chunks; ++c) {
                    JpegMarker m{0xE2, {}};
                    const char* tag = "ICC_PROFILE";
                    m.payload.insert(m.payload.end(), tag, tag + 12);  // includes NUL
                    m.payload.push_back((uint8_t)(c + 1));
                    m.payload.push_back((uint8_t)chunks);
                    size_t b = c * chunk, e = std::min(sz, b + chunk);
                    m.payload.insert(m.payload.end(), icc.begin() + b, icc.begin() + e);
                    markers.push_back(std::move(m));
                }
            }
        }
    } else {
        heif_color_profile_nclx* nclx = nullptr;
        if (heif_image_handle_get_nclx_color_profile(h, &nclx).code == heif_error_Ok && nclx) {
            int prim = nclx->color_primaries, trc = nclx->transfer_characteristics;
            if (trc == 16 || trc == 18)
                warnings += "Source is HDR (PQ/HLG); JPEG is SDR so tones will look flat. ";
            if (prim != 1 && prim != 2)
                warnings += "Source uses wide-gamut primaries without an ICC profile; colors may look muted. ";
            heif_nclx_color_profile_free(nclx);
        }
    }

    // XMP -> APP1 "http://ns.adobe.com/xap/1.0/\0"
    int nMime = heif_image_handle_get_number_of_metadata_blocks(h, "mime");
    if (nMime > 0) {
        std::vector<heif_item_id> ids(nMime);
        heif_image_handle_get_list_of_metadata_block_IDs(h, "mime", ids.data(), nMime);
        for (heif_item_id id : ids) {
            const char* ct = heif_image_handle_get_metadata_content_type(h, id);
            if (!ct || std::strcmp(ct, "application/rdf+xml") != 0) continue;
            size_t sz = heif_image_handle_get_metadata_size(h, id);
            const char* ns = "http://ns.adobe.com/xap/1.0/";
            size_t nsLen = std::strlen(ns) + 1;
            if (sz == 0 || sz + nsLen > 65533) continue;
            JpegMarker m{0xE1, {}};
            m.payload.insert(m.payload.end(), ns, ns + nsLen);
            size_t base = m.payload.size();
            m.payload.resize(base + sz);
            if (heif_image_handle_get_metadata(h, id, m.payload.data() + base).code == heif_error_Ok)
                markers.push_back(std::move(m));
            break;
        }
    }
}

}  // namespace

// Converts the primary image of a HEIF file to a maximum-quality JPEG.
// Returns "" on success or an error message.
std::string convertHeifToJpeg(const uint8_t* data, size_t len, FILE* out, int quality,
                              std::string& warnings, int& outW, int& outH) {
    std::unique_ptr<heif_context, CtxDeleter> ctx(heif_context_alloc());
    heif_error err = heif_context_read_from_memory_without_copy(ctx.get(), data, len, nullptr);
    if (err.code != heif_error_Ok) return std::string("Not a readable HEIF file: ") + err.message;

    heif_image_handle* rawHandle = nullptr;
    err = heif_context_get_primary_image_handle(ctx.get(), &rawHandle);
    if (err.code != heif_error_Ok) return std::string("No primary image: ") + err.message;
    std::unique_ptr<heif_image_handle, HandleDeleter> handle(rawHandle);

    int bits = heif_image_handle_get_luma_bits_per_pixel(handle.get());
    bool highBit = bits > 8;

    std::unique_ptr<heif_decoding_options, OptionsDeleter> opts(heif_decoding_options_alloc());
    opts->convert_hdr_to_8bit = 0;
    opts->color_conversion_options.preferred_chroma_upsampling_algorithm = heif_chroma_upsampling_bilinear;
    opts->color_conversion_options.only_use_preferred_chroma_algorithm = 0;

    heif_image* rawImg = nullptr;
    err = heif_decode_image(handle.get(), &rawImg, heif_colorspace_RGB,
                            highBit ? heif_chroma_interleaved_RRGGBB_LE : heif_chroma_interleaved_RGB,
                            opts.get());
    if (err.code != heif_error_Ok) return std::string("Decoding failed: ") + err.message;
    std::unique_ptr<heif_image, ImageDeleter> img(rawImg);

    int stride = 0;
    const uint8_t* pix = heif_image_get_plane_readonly(img.get(), heif_channel_interleaved, &stride);
    if (!pix) return "Decoder returned no pixel data";
    outW = heif_image_get_width(img.get(), heif_channel_interleaved);
    outH = heif_image_get_height(img.get(), heif_channel_interleaved);
    int depth = highBit ? heif_image_get_bits_per_pixel_range(img.get(), heif_channel_interleaved) : 8;
    if (depth <= 8 || depth > 16) depth = highBit ? bits : 8;

    std::vector<JpegMarker> markers;
    collectMetadata(handle.get(), outW, outH, markers, warnings);

    LOGI("decoded %dx%d, %d-bit source", outW, outH, bits);
    JpegSource src{pix, outW, outH, stride, highBit ? 2 : 1, depth};
    return encodeJpeg(src, quality, markers, out);
}

std::string convertRawToJpeg(const uint8_t* data, size_t len, FILE* out, int quality,
                             std::string& warnings, int& outW, int& outH);

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM*, void*) {
    heif_init(nullptr);
    return JNI_VERSION_1_6;
}

// Returns "OK|<width>x<height>|<warnings>" on success or "ERR|<message>".
extern "C" JNIEXPORT jstring JNICALL
Java_io_github_limegre3n_heif2jpeg_NativeConverter_convert(JNIEnv* env, jclass, jbyteArray input,
                                                           jint outFd, jint quality) {
    std::string result;
    jsize len = env->GetArrayLength(input);
    jbyte* bytes = env->GetByteArrayElements(input, nullptr);
    if (!bytes) return env->NewStringUTF("ERR|Out of memory reading input");

    int fd = dup(outFd);
    FILE* out = fd >= 0 ? fdopen(fd, "wb") : nullptr;
    if (!out) {
        if (fd >= 0) close(fd);
        result = "ERR|Cannot open output file";
    } else {
        std::string warnings;
        int w = 0, h = 0;
        const uint8_t* data = reinterpret_cast<const uint8_t*>(bytes);
        // HEIF files carry an ISO-BMFF 'ftyp' box at offset 4; anything else goes to LibRaw.
        bool isHeif = len >= 12 && std::memcmp(data + 4, "ftyp", 4) == 0;
        std::string e = isHeif
            ? convertHeifToJpeg(data, (size_t)len, out, quality, warnings, w, h)
            : convertRawToJpeg(data, (size_t)len, out, quality, warnings, w, h);
        if (fclose(out) != 0 && e.empty()) e = "Failed to finish writing output";
        result = e.empty() ? "OK|" + std::to_string(w) + "x" + std::to_string(h) + "|" + warnings
                           : "ERR|" + e;
    }
    env->ReleaseByteArrayElements(input, bytes, JNI_ABORT);
    return env->NewStringUTF(result.c_str());
}
