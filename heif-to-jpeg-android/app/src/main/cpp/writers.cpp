// Output writers: JPEG (own encoder) and AVIF (libheif + libaom).

#include <algorithm>
#include <cstring>
#include <memory>
#include <thread>

#include <libheif/heif.h>

#include "image.h"
#include "jpeg_encoder.h"

std::string writeJpeg(const DecodedImage& img, const OutputOptions& opt, FILE* out) {
    std::vector<JpegMarker> markers;

    if (opt.keepMetadata && !img.exifTiff.empty()) {
        JpegMarker m{0xE1, {'E', 'x', 'i', 'f', 0, 0}};
        m.payload.insert(m.payload.end(), img.exifTiff.begin(), img.exifTiff.end());
        if (m.payload.size() <= 65533) markers.push_back(std::move(m));
    }
    // The ICC profile is colour information, not personal metadata: always kept.
    if (!img.icc.empty()) {
        const size_t chunk = 65519;
        const size_t chunks = (img.icc.size() + chunk - 1) / chunk;
        if (chunks <= 255) {
            for (size_t c = 0; c < chunks; ++c) {
                JpegMarker m{0xE2, {}};
                const char* tag = "ICC_PROFILE";
                m.payload.insert(m.payload.end(), tag, tag + 12);  // includes NUL
                m.payload.push_back(static_cast<uint8_t>(c + 1));
                m.payload.push_back(static_cast<uint8_t>(chunks));
                size_t b = c * chunk, e = std::min(img.icc.size(), b + chunk);
                m.payload.insert(m.payload.end(), img.icc.begin() + b, img.icc.begin() + e);
                markers.push_back(std::move(m));
            }
        }
    }
    if (opt.keepMetadata && !img.xmp.empty()) {
        const char* ns = "http://ns.adobe.com/xap/1.0/";
        const size_t nsLen = std::strlen(ns) + 1;
        if (img.xmp.size() + nsLen <= 65533) {
            JpegMarker m{0xE1, {}};
            m.payload.insert(m.payload.end(), ns, ns + nsLen);
            m.payload.insert(m.payload.end(), img.xmp.begin(), img.xmp.end());
            markers.push_back(std::move(m));
        }
    }

    JpegSource src{img.data, img.width, img.height, img.stride, img.bytesPerSample, img.bitDepth};
    JpegOptions jo;
    jo.quality = opt.quality;
    jo.subsample420 = opt.subsample420;
    return encodeJpeg(src, jo, markers, out);
}

namespace {

struct CtxDeleter { void operator()(heif_context* c) const { heif_context_free(c); } };
struct EncoderDeleter { void operator()(heif_encoder* e) const { heif_encoder_release(e); } };
struct ImageDeleter { void operator()(heif_image* i) const { heif_image_release(i); } };
struct HandleDeleter { void operator()(heif_image_handle* h) const { heif_image_handle_release(h); } };
struct EncOptsDeleter { void operator()(heif_encoding_options* o) const { heif_encoding_options_free(o); } };

heif_error writeToFile(heif_context*, const void* data, size_t size, void* userdata) {
    FILE* f = static_cast<FILE*>(userdata);
    if (fwrite(data, 1, size, f) != size)
        return {heif_error_Encoding_error, heif_suberror_Cannot_write_output_data, "write failed"};
    return {heif_error_Ok, heif_suberror_Unspecified, "Success"};
}

}  // namespace

std::string writeAvif(const DecodedImage& img, const OutputOptions& opt, FILE* out) {
    std::unique_ptr<heif_context, CtxDeleter> ctx(heif_context_alloc());

    heif_encoder* rawEnc = nullptr;
    heif_error err = heif_context_get_encoder_for_format(ctx.get(), heif_compression_AV1, &rawEnc);
    if (err.code != heif_error_Ok) return std::string("AVIF encoder not available: ") + err.message;
    std::unique_ptr<heif_encoder, EncoderDeleter> enc(rawEnc);

    heif_encoder_set_lossy_quality(enc.get(), std::max(0, std::min(100, opt.quality)));
    heif_encoder_set_parameter(enc.get(), "chroma", opt.subsample420 ? "420" : "444");
    heif_encoder_set_parameter(enc.get(), "speed", "6");
    const unsigned hw = std::max(1u, std::min(8u, std::thread::hardware_concurrency()));
    heif_encoder_set_parameter(enc.get(), "threads", std::to_string(hw).c_str());
    heif_encoder_set_parameter(enc.get(), "auto-tiles", "true");

    // 10-bit RGB input keeps the extra precision of 10-bit HEIF and RAW sources.
    heif_image* rawImg = nullptr;
    err = heif_image_create(img.width, img.height, heif_colorspace_RGB,
                            heif_chroma_interleaved_RRGGBB_LE, &rawImg);
    if (err.code != heif_error_Ok) return std::string("Cannot create image: ") + err.message;
    std::unique_ptr<heif_image, ImageDeleter> himg(rawImg);
    err = heif_image_add_plane(himg.get(), heif_channel_interleaved, img.width, img.height, 10);
    if (err.code != heif_error_Ok) return std::string("Cannot allocate image: ") + err.message;

    int dstStride = 0;
    uint8_t* dst = heif_image_get_plane(himg.get(), heif_channel_interleaved, &dstStride);
    if (!dst) return "Cannot access image plane";
    const uint32_t maxIn = (1u << img.bitDepth) - 1;
    for (int y = 0; y < img.height; ++y) {
        const uint8_t* s8 = img.data + static_cast<size_t>(y) * img.stride;
        uint16_t* d = reinterpret_cast<uint16_t*>(dst + static_cast<size_t>(y) * dstStride);
        const int n = img.width * 3;
        if (img.bytesPerSample == 1) {
            for (int i = 0; i < n; ++i) d[i] = static_cast<uint16_t>((s8[i] * 1023u + 127u) / 255u);
        } else if (img.bitDepth == 10) {
            std::memcpy(d, s8, static_cast<size_t>(n) * 2);
        } else {
            const uint16_t* s16 = reinterpret_cast<const uint16_t*>(s8);
            for (int i = 0; i < n; ++i)
                d[i] = static_cast<uint16_t>((s16[i] * 1023u + maxIn / 2) / maxIn);
        }
    }

    // Colour: embed the ICC profile, or signal the source's primaries/transfer
    // (this keeps wide-gamut and HLG/PQ HDR photos correct in AVIF).
    if (!img.icc.empty()) {
        heif_image_set_raw_color_profile(himg.get(), "prof", img.icc.data(), img.icc.size());
    } else {
        heif_color_profile_nclx* nclx = heif_nclx_color_profile_alloc();
        if (nclx) {
            nclx->color_primaries = static_cast<heif_color_primaries>(img.nclxPrimaries);
            nclx->transfer_characteristics = static_cast<heif_transfer_characteristics>(img.nclxTransfer);
            nclx->matrix_coefficients = heif_matrix_coefficients_ITU_R_BT_601_6;
            nclx->full_range_flag = 1;
            heif_image_set_nclx_color_profile(himg.get(), nclx);
            heif_nclx_color_profile_free(nclx);
        }
    }

    std::unique_ptr<heif_encoding_options, EncOptsDeleter> eo(heif_encoding_options_alloc());
    heif_image_handle* rawHandle = nullptr;
    err = heif_context_encode_image(ctx.get(), himg.get(), enc.get(), eo.get(), &rawHandle);
    if (err.code != heif_error_Ok) return std::string("AVIF encoding failed: ") + err.message;
    std::unique_ptr<heif_image_handle, HandleDeleter> handle(rawHandle);

    if (opt.keepMetadata) {
        if (!img.exifTiff.empty())
            heif_context_add_exif_metadata(ctx.get(), handle.get(), img.exifTiff.data(),
                                           static_cast<int>(img.exifTiff.size()));
        if (!img.xmp.empty())
            heif_context_add_XMP_metadata(ctx.get(), handle.get(), img.xmp.data(),
                                          static_cast<int>(img.xmp.size()));
    }

    heif_writer writer{};
    writer.writer_api_version = 1;
    writer.write = writeToFile;
    err = heif_context_write(ctx.get(), &writer, out);
    if (err.code != heif_error_Ok) return std::string("Failed writing AVIF: ") + err.message;
    return "";
}
