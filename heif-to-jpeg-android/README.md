# HEIF to JPEG (Android)

A small Android app that converts HEIF / HEIC / HIF photos, including the
**10-bit 4:2:2** files from Sony, Canon, Fujifilm and similar cameras, and
**Sony ARW RAW** files to the highest-quality JPEG the format allows.

## What it does

1. **Choose folder**: pick a folder with the system folder picker. The app
   lists every `.heic`, `.heif`, `.hif` and `.arw` file in it.
2. Tick the files to convert (all are ticked by default).
3. Optionally tick **Replace originals**. Each HEIF is deleted only after its
   JPEG has been written. Files that fail to convert are never deleted.
4. Tap **Convert**. JPEGs are saved next to the originals with the same name
   (`DSC01234.HIF` becomes `DSC01234.jpg`). If that name is taken, the app
   adds `_1`, `_2` and so on, so it never overwrites an existing file. (If you
   shot RAW+HEIF and convert both, the second one becomes `DSC01234_1.jpg`.)

## Quality settings

| Setting            | Value                                                           |
|--------------------|-----------------------------------------------------------------|
| Decoder            | libheif + libde265, a software decoder bundled in the app, so it doesn't depend on the phone's hardware HEVC decoder (which usually can't decode 4:2:2) |
| Chroma upsampling  | Bilinear (4:2:2 to full resolution)                             |
| JPEG quality       | 100: every quantization step is 1, the lowest JPEG allows        |
| JPEG subsampling   | 4:4:4 (no chroma subsampling)                                   |
| Bit depth          | 10-bit samples go straight into the DCT as floats, not rounded to 8 bits first |
| Metadata           | EXIF, XMP and embedded ICC profiles are copied. Orientation is applied to the pixels and the EXIF Orientation tag is reset to "normal" |

### Limits of the JPEG format

The JPEG format can't store an image with zero loss:

* Baseline JPEG holds **8 bits per channel**, so 10-bit tonal precision is
  reduced.
* JPEG compression always rounds DCT coefficients. With every quantization
  step set to 1, the result measures about 51 dB PSNR, which is visually
  indistinguishable from the source. Files are large (often 3 to 5 times the
  HEIF size).
* HDR (HLG/PQ) HEIFs are converted as-is. They will look flat because JPEG is
  SDR. The app shows a note when it sees one.
* If the HEIF signals wide-gamut primaries without an ICC profile (some phones
  do this), no ICC profile is written, so colors may look slightly muted.

If you need a truly lossless result, convert to 16-bit PNG or TIFF instead.

## ARW (RAW) conversion

A RAW file is sensor data, not a finished picture, so it has to be
*developed*. The app uses [LibRaw](https://www.libraw.org/) with these settings:

| Setting        | Value                                                        |
|----------------|--------------------------------------------------------------|
| Demosaicing    | AHD                                                          |
| White balance  | As shot (camera setting)                                     |
| Colour space   | sRGB                                                         |
| Precision      | 16 bits per channel all the way into the JPEG encoder        |
| Brightness     | LibRaw default auto-brightness (clips the brightest 1%)      |
| Highlights     | Clipped                                                      |
| Lens/rotation  | Camera rotation applied. No lens distortion/vignetting correction |
| Metadata       | Make, model, date, exposure time, aperture, ISO, focal length, lens and GPS are written to the JPEG's EXIF |

The JPEG encoding is the same quality-100, 4:4:4 encoder used for HEIF.

Colours and contrast **won't match Sony's in-camera JPEGs**. Sony's picture
profiles, Creative Looks, DRO and lens corrections are proprietary. Use a RAW
editor (Lightroom, Capture One, darktable) if you need full control.

Be careful with **Replace originals** for ARW files: a RAW file holds much more
than any JPEG can (14-bit data, recoverable highlights, editable white
balance). The app shows an extra warning before deleting ARW files.

## Building

GitHub Actions builds the APK on every push that touches this folder
(`.github/workflows/heif-to-jpeg-apk.yml`). Each build is published as a
GitHub Release named `heif-to-jpeg-build-N` with `HeifToJpeg.apk` attached.

Local build (Android SDK + NDK 27 required; git must be on PATH because the
native build downloads libheif, libde265 and LibRaw):

```sh
cd heif-to-jpeg-android
./gradlew assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```

The APK is signed with the debug key so it installs directly. Install needs
Android 8.0+ on a 64-bit (arm64) device.
