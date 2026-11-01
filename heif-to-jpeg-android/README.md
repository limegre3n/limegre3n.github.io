# Photo Converter (Android)

A small Android app that converts HEIF / HEIC / HIF photos, including the
**10-bit 4:2:2** files from Sony, Canon, Fujifilm and similar cameras, and
**Sony ARW RAW** files to JPEG or AVIF, from maximum quality to compact.

## What it does

1. **Choose a folder.** The app shows every `.heic`, `.heif`, `.hif` and
   `.arw` photo in it as a grid with thumbnails. Filter by All, HEIF or RAW,
   and tap photos to select or deselect them.
2. **Pick the output** from the bar at the bottom: format (JPEG or AVIF),
   a quality preset with estimated sizes, **Keep metadata**, and
   **Replace originals**.
3. **Convert.** The app keeps working in the background (with a progress
   notification and a Stop button) and shows:
   * photos **done**, photos **remaining** and **time left**
   * a progress bar with one segment per photo and the estimated finish time
   * the photos up next, each with its own estimate
4. **Done screen.** Shows the total size, time taken, whether originals were
   deleted, and a note for any photo that failed or needs attention (for
   example HDR photos converted to JPEG).

New files are saved next to the originals with the same name
(`DSC01234.HIF` becomes `DSC01234.jpg`). If that name is taken, the app adds
`_1`, `_2` and so on, so it never overwrites an existing file. With
**Replace originals**, each original is deleted only after its new file has
been written, and the app asks you to confirm first (with an extra warning
for RAW files).

### Time estimate

Before the first photo finishes, the estimate is a rough guess based on file
size. After that the app times each photo and uses seconds per megabyte,
measured separately for HEIF and RAW, so mixed batches get a sensible
estimate. The percentage for the photo being converted is an estimate too,
because the decoders don't report their own progress.

## Output formats

| Format | Preset   | Settings                         | Typical size vs. a 12 MB HEIF |
|--------|----------|----------------------------------|-------------------------------|
| JPEG   | Maximum  | Quality 100, 4:4:4               | ~3x larger                    |
| JPEG   | **High** (default) | Quality 95, 4:4:4      | about the same                |
| JPEG   | Compact  | Quality 90, 4:2:0                | ~half                         |
| AVIF   | High     | Quality 90, 10-bit, 4:4:4        | ~half                         |
| AVIF   | Balanced | Quality 75, 10-bit, 4:2:0        | ~quarter                      |
| AVIF   | Compact  | Quality 60, 10-bit, 4:2:0        | ~eighth                       |

The sizes are rough estimates; real sizes depend on the photo. JPEG opens
everywhere. AVIF keeps 10-bit colour and HDR (HLG/PQ) and opens on Android
12+, in Chrome and in Apple Photos, but is several times slower to encode.

The JPEG encoder uses optimized Huffman tables, which makes files 5-10%
smaller with no change in quality. In a local test it matched or beat libjpeg
(with optimization on) on both size and quality at every preset.

## Quality settings

| Setting            | Value                                                           |
|--------------------|-----------------------------------------------------------------|
| Decoder            | libheif + libde265, a software decoder bundled in the app, so it doesn't depend on the phone's hardware HEVC decoder (which usually can't decode 4:2:2) |
| Chroma upsampling  | Bilinear (4:2:2 to full resolution)                             |
| JPEG quality       | Maximum preset: 100, every quantization step is 1, the lowest JPEG allows |
| JPEG subsampling   | 4:4:4 (no chroma subsampling) for Maximum and High              |
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

The output uses the same encoders and presets as for HEIF.

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
native build downloads libheif, libde265, libaom and LibRaw):

```sh
cd heif-to-jpeg-android
./gradlew assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```

The APK is signed with the debug key so it installs directly. Install needs
Android 8.0+ on a 64-bit (arm64) device.
