package io.github.limegre3n.heif2jpeg

/** Bridge to the native libheif + JPEG encoder (see src/main/cpp). */
object NativeConverter {
    init {
        System.loadLibrary("heif2jpeg")
    }

    /**
     * Decodes [heif] and writes a JPEG to the already-open file descriptor [outFd].
     * Returns "OK|<w>x<h>|<warnings>" or "ERR|<message>".
     */
    @JvmStatic
    external fun convert(heif: ByteArray, outFd: Int, quality: Int): String
}
