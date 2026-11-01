// HEIF/HEIC/HIF decoding (libheif + libde265) into a DecodedImage.

#include <algorithm>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <libheif/heif.h>

#include "image.h"

namespace {

struct CtxDeleter { void operator()(heif_context* c) const { heif_context_free(c); } };
struct HandleDeleter { void operator()(heif_image_handle* h) const { heif_image_handle_release(h); } };
struct OptionsDeleter { void operator()(heif_decoding_options* o) const { heif_decoding_options_free(o); } };

// ---- Minimal TIFF/EXIF patching ---------------------------------------------
// libheif applies the HEIF rotation/mirror boxes to the pixels, so the output must
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

void collectMetadata(heif_image_handle* h, DecodedImage& img) {
    // EXIF: libheif returns a 4-byte offset to the TIFF header, then the data.
    int nExif = heif_image_handle_get_number_of_metadata_blocks(h, "Exif");
    if (nExif > 0) {
        heif_item_id id;
        heif_image_handle_get_list_of_metadata_block_IDs(h, "Exif", &id, 1);
        size_t sz = heif_image_handle_get_metadata_size(h, id);
        std::vector<uint8_t> raw(sz);
        if (sz > 4 && heif_image_handle_get_metadata(h, id, raw.data()).code == heif_error_Ok) {
            uint32_t off = (uint32_t)raw[0] << 24 | (uint32_t)raw[1] << 16 | (uint32_t)raw[2] << 8 | raw[3];
            size_t start = 4 + (size_t)off;
            if (start + 6 <= sz && std::memcmp(&raw[start], "Exif\0\0", 6) == 0) start += 6;
            if (start < sz) {
                img.exifTiff.assign(raw.begin() + start, raw.end());
                patchExif(img.exifTiff, img.width, img.height);
            }
        }
    }

    heif_color_profile_type cpt = heif_image_handle_get_color_profile_type(h);
    if (cpt == heif_color_profile_type_prof || cpt == heif_color_profile_type_rICC) {
        size_t sz = heif_image_handle_get_raw_color_profile_size(h);
        img.icc.resize(sz);
        if (sz == 0 || heif_image_handle_get_raw_color_profile(h, img.icc.data()).code != heif_error_Ok)
            img.icc.clear();
    }
    heif_color_profile_nclx* nclx = nullptr;
    if (heif_image_handle_get_nclx_color_profile(h, &nclx).code == heif_error_Ok && nclx) {
        img.nclxPrimaries = nclx->color_primaries;
        img.nclxTransfer = nclx->transfer_characteristics;
        heif_nclx_color_profile_free(nclx);
        if (img.icc.empty()) {
            if (img.nclxTransfer == 16 || img.nclxTransfer == 18)
                img.warnings += "HDR (PQ/HLG) photo: JPEG can't store HDR, so it may look flatter. ";
            if (img.nclxPrimaries != 1 && img.nclxPrimaries != 2)
                img.warnings += "Wide-gamut colour without an ICC profile: colours may look muted in JPEG. ";
        }
    }

    // XMP
    int nMime = heif_image_handle_get_number_of_metadata_blocks(h, "mime");
    if (nMime > 0) {
        std::vector<heif_item_id> ids(nMime);
        heif_image_handle_get_list_of_metadata_block_IDs(h, "mime", ids.data(), nMime);
        for (heif_item_id id : ids) {
            const char* ct = heif_image_handle_get_metadata_content_type(h, id);
            if (!ct || std::strcmp(ct, "application/rdf+xml") != 0) continue;
            size_t sz = heif_image_handle_get_metadata_size(h, id);
            img.xmp.resize(sz);
            if (sz == 0 || heif_image_handle_get_metadata(h, id, img.xmp.data()).code != heif_error_Ok)
                img.xmp.clear();
            break;
        }
    }
}

}  // namespace

std::string decodeHeif(const uint8_t* data, size_t len, DecodedImage& out) {
    std::unique_ptr<heif_context, CtxDeleter> ctx(heif_context_alloc());
    heif_error err = heif_context_read_from_memory_without_copy(ctx.get(), data, len, nullptr);
    if (err.code != heif_error_Ok) return std::string("Not a readable HEIF file: ") + err.message;

    heif_image_handle* rawHandle = nullptr;
    err = heif_context_get_primary_image_handle(ctx.get(), &rawHandle);
    if (err.code != heif_error_Ok) return std::string("No primary image: ") + err.message;
    std::unique_ptr<heif_image_handle, HandleDeleter> handle(rawHandle);

    const int bits = heif_image_handle_get_luma_bits_per_pixel(handle.get());
    const bool highBit = bits > 8;

    std::unique_ptr<heif_decoding_options, OptionsDeleter> opts(heif_decoding_options_alloc());
    opts->convert_hdr_to_8bit = 0;
    opts->color_conversion_options.preferred_chroma_upsampling_algorithm = heif_chroma_upsampling_bilinear;
    opts->color_conversion_options.only_use_preferred_chroma_algorithm = 0;

    heif_image* rawImg = nullptr;
    err = heif_decode_image(handle.get(), &rawImg, heif_colorspace_RGB,
                            highBit ? heif_chroma_interleaved_RRGGBB_LE : heif_chroma_interleaved_RGB,
                            opts.get());
    if (err.code != heif_error_Ok) return std::string("Decoding failed: ") + err.message;
    std::shared_ptr<heif_image> img(rawImg, [](heif_image* i) { heif_image_release(i); });

    int stride = 0;
    const uint8_t* pix = heif_image_get_plane_readonly(img.get(), heif_channel_interleaved, &stride);
    if (!pix) return "Decoder returned no pixel data";

    out.data = pix;
    out.stride = stride;
    out.width = heif_image_get_width(img.get(), heif_channel_interleaved);
    out.height = heif_image_get_height(img.get(), heif_channel_interleaved);
    out.bytesPerSample = highBit ? 2 : 1;
    int depth = highBit ? heif_image_get_bits_per_pixel_range(img.get(), heif_channel_interleaved) : 8;
    if (depth <= 8 || depth > 16) depth = highBit ? bits : 8;
    out.bitDepth = depth;
    out.owner = img;

    collectMetadata(handle.get(), out);
    return "";
}
