package io.github.limegre3n.heif2jpeg

/** Bridge to the native decoders (libheif, LibRaw) and encoders (JPEG, AVIF). See src/main/cpp. */
object NativeConverter {
    init {
        System.loadLibrary("heif2jpeg")
    }

    const val FORMAT_JPEG = 0
    const val FORMAT_AVIF = 1

    /**
     * Decodes [input] (HEIF or camera RAW) and writes the result to the already-open
     * file descriptor [outFd]. Returns "OK|<w>x<h>|<notes>" or "ERR|<message>".
     */
    @JvmStatic
    external fun convert(
        input: ByteArray,
        outFd: Int,
        format: Int,
        quality: Int,
        subsample420: Boolean,
        keepMetadata: Boolean,
    ): String
}
