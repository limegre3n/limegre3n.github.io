package io.github.limegre3n.heif2jpeg

import android.content.Context
import android.net.Uri

enum class PhotoKind(val badge: String) { HEIF("HIF"), RAW("ARW") }

data class Photo(val uri: Uri, val name: String, val size: Long, val kind: PhotoKind)

/**
 * A quality preset. [heifRatio]/[rawRatio] estimate output size as a fraction of the
 * source file size (rough averages for camera photos, used only for the "≈" labels).
 */
data class Preset(
    val name: String,
    val detail: String,
    val quality: Int,
    val subsample420: Boolean,
    val heifRatio: Double,
    val rawRatio: Double,
)

enum class OutputFormat(
    val label: String,
    val extension: String,
    val mime: String,
    val nativeId: Int,
    val note: String,
    val presets: List<Preset>,
    /** How much slower than JPEG encoding is, for the time estimate before any photo is measured. */
    val timeFactor: Double,
) {
    JPEG(
        "JPEG", "jpg", "image/jpeg", NativeConverter.FORMAT_JPEG,
        "Opens everywhere: every phone, computer, website and printer.",
        listOf(
            Preset("Maximum", "Quality 100 · full color detail (4:4:4)", 100, false, 2.8, 0.85),
            Preset("High", "Quality 95 · visually identical (4:4:4)", 95, false, 1.0, 0.3),
            Preset("Compact", "Quality 90 · standard color (4:2:0)", 90, true, 0.5, 0.15),
        ),
        1.0,
    ),
    AVIF(
        "AVIF", "avif", "image/avif", NativeConverter.FORMAT_AVIF,
        "Much smaller files that keep 10-bit color and HDR. Opens on Android 12+, in Chrome " +
            "and in Apple Photos. Slower to create than JPEG.",
        listOf(
            Preset("High", "Quality 90 · 10-bit 4:4:4", 90, false, 0.5, 0.15),
            Preset("Balanced", "Quality 75 · 10-bit 4:2:0", 75, true, 0.25, 0.075),
            Preset("Compact", "Quality 60 · 10-bit 4:2:0", 60, true, 0.12, 0.04),
        ),
        3.0,
    ),
}

data class Settings(
    val format: OutputFormat = OutputFormat.JPEG,
    val presetIndex: Map<OutputFormat, Int> = mapOf(OutputFormat.JPEG to 1, OutputFormat.AVIF to 0),
    val keepMetadata: Boolean = true,
    val replaceOriginals: Boolean = false,
) {
    val preset: Preset get() = format.presets[presetIndex[format] ?: 0]

    fun estimateBytes(photos: Collection<Photo>): Long = photos.sumOf {
        (it.size * if (it.kind == PhotoKind.RAW) preset.rawRatio else preset.heifRatio).toLong()
    }
}

object SettingsStore {
    private const val PREFS = "settings"

    fun load(context: Context): Settings {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val format = runCatching { OutputFormat.valueOf(p.getString("format", "JPEG")!!) }
            .getOrDefault(OutputFormat.JPEG)
        return Settings(
            format = format,
            presetIndex = OutputFormat.entries.associateWith { f ->
                p.getInt("preset_${f.name}", if (f == OutputFormat.JPEG) 1 else 0)
                    .coerceIn(0, f.presets.size - 1)
            },
            keepMetadata = p.getBoolean("keepMetadata", true),
            replaceOriginals = p.getBoolean("replace", false),
        )
    }

    fun save(context: Context, s: Settings) {
        val e = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        e.putString("format", s.format.name)
        s.presetIndex.forEach { (f, i) -> e.putInt("preset_${f.name}", i) }
        e.putBoolean("keepMetadata", s.keepMetadata)
        e.putBoolean("replace", s.replaceOriginals)
        e.apply()
    }
}

fun formatBytes(bytes: Long): String = when {
    bytes >= 1_000_000_000 -> "%.1f GB".format(bytes / 1e9)
    bytes >= 10_000_000 -> "%d MB".format(Math.round(bytes / 1e6))
    bytes >= 1_000_000 -> "%.1f MB".format(bytes / 1e6)
    else -> "%d KB".format(Math.max(1, Math.round(bytes / 1e3)))
}

fun formatDuration(seconds: Double): String {
    val s = Math.max(0, Math.round(seconds)).toInt()
    if (s < 60) return "$s s"
    val m = s / 60
    val r = s % 60
    if (m < 60) return if (r == 0 || m >= 10) "$m min" else "$m min $r s"
    return "${m / 60} h ${m % 60} min"
}
