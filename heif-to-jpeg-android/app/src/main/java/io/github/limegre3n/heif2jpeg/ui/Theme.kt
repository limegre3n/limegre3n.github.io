package io.github.limegre3n.heif2jpeg.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** Colours in the spirit of iOS system colours, tuned for 4.5:1 text contrast. */
data class Palette(
    val bg: Color,
    val card: Color,
    val label: Color,
    val secondary: Color,
    val separator: Color,
    val segBg: Color,
    val segOn: Color,
    val bar: Color,
    val accent: Color,
    val accentSoft: Color,
    val green: Color,
    val red: Color,
    val orange: Color,
    val track: Color,
    val dark: Boolean,
)

val LightPalette = Palette(
    bg = Color(0xFFF2F2F7), card = Color.White, label = Color.Black, secondary = Color(0xFF6E6E73),
    separator = Color(0xFFC6C6C8), segBg = Color(0xFFE3E3E8), segOn = Color.White,
    bar = Color(0xF0F9F9FB), accent = Color(0xFF0066CC), accentSoft = Color(0x1F0066CC),
    green = Color(0xFF248A3D), red = Color(0xFFD70015), orange = Color(0xFFC93400),
    track = Color(0xFFE3E3E8), dark = false,
)

val DarkPalette = Palette(
    bg = Color.Black, card = Color(0xFF1C1C1E), label = Color.White, secondary = Color(0xFFAEAEB2),
    separator = Color(0xFF38383A), segBg = Color(0xFF1C1C1E), segOn = Color(0xFF636366),
    bar = Color(0xF0161618), accent = Color(0xFF409CFF), accentSoft = Color(0x2E409CFF),
    green = Color(0xFF30D158), red = Color(0xFFFF6961), orange = Color(0xFFFF9F0A),
    track = Color(0xFF3A3A3C), dark = true,
)

val LocalPalette = staticCompositionLocalOf { LightPalette }

object Type {
    val largeTitle = TextStyle(fontSize = 34.sp, lineHeight = 41.sp, fontWeight = FontWeight.Bold)
    val title2 = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold)
    val headline = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)
    val body = TextStyle(fontSize = 17.sp, lineHeight = 22.sp)
    val callout = TextStyle(fontSize = 16.sp, lineHeight = 21.sp)
    val subhead = TextStyle(fontSize = 15.sp, lineHeight = 20.sp)
    val footnote = TextStyle(fontSize = 13.sp, lineHeight = 18.sp)
    val caption = TextStyle(fontSize = 11.sp, lineHeight = 13.sp, fontWeight = FontWeight.SemiBold)
}

@Composable
fun AppTheme(content: @Composable () -> Unit) {
    val palette = if (isSystemInDarkTheme()) DarkPalette else LightPalette
    CompositionLocalProvider(LocalPalette provides palette, content = content)
}
