// JNI entry points for io.github.limegre3n.heif2jpeg.NativeConverter.

#include <jni.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <string>

#include <libheif/heif.h>

#include "image.h"

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM*, void*) {
    heif_init(nullptr);
    return JNI_VERSION_1_6;
}

// format: 0 = JPEG, 1 = AVIF.
// Returns "OK|<width>x<height>|<warnings>" or "ERR|<message>".
extern "C" JNIEXPORT jstring JNICALL
Java_io_github_limegre3n_heif2jpeg_NativeConverter_convert(JNIEnv* env, jclass, jbyteArray input,
                                                           jint outFd, jint format, jint quality,
                                                           jboolean subsample420, jboolean keepMetadata) {
    jsize len = env->GetArrayLength(input);
    jbyte* bytes = env->GetByteArrayElements(input, nullptr);
    if (!bytes) return env->NewStringUTF("ERR|Out of memory reading input");
    const uint8_t* data = reinterpret_cast<const uint8_t*>(bytes);

    std::string result;
    DecodedImage img;
    // HEIF files carry an ISO-BMFF 'ftyp' box at offset 4; anything else goes to LibRaw.
    const bool isHeif = len >= 12 && std::memcmp(data + 4, "ftyp", 4) == 0;
    std::string e = isHeif ? decodeHeif(data, static_cast<size_t>(len), img)
                           : decodeRaw(data, static_cast<size_t>(len), img);
    if (!e.empty()) {
        env->ReleaseByteArrayElements(input, bytes, JNI_ABORT);
        return env->NewStringUTF(("ERR|" + e).c_str());
    }

    int fd = dup(outFd);
    FILE* out = fd >= 0 ? fdopen(fd, "wb") : nullptr;
    if (!out) {
        if (fd >= 0) close(fd);
        result = "ERR|Cannot open output file";
    } else {
        OutputOptions opt;
        opt.quality = quality;
        opt.subsample420 = subsample420;
        opt.keepMetadata = keepMetadata;
        e = format == 1 ? writeAvif(img, opt, out) : writeJpeg(img, opt, out);
        if (fclose(out) != 0 && e.empty()) e = "Failed to finish writing output";
        // AVIF keeps HDR and wide gamut, so those notes only apply to JPEG.
        std::string notes = format == 1 ? "" : img.warnings;
        result = e.empty() ? "OK|" + std::to_string(img.width) + "x" + std::to_string(img.height) + "|" + notes
                           : "ERR|" + e;
    }
    img = DecodedImage();  // free pixels before releasing the input array
    env->ReleaseByteArrayElements(input, bytes, JNI_ABORT);
    return env->NewStringUTF(result.c_str());
}
