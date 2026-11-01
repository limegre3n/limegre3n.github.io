package io.github.limegre3n.heif2jpeg.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Text

@Composable
fun SegmentedControl(options: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(9.dp))
            .background(p.segBg)
            .padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        options.forEachIndexed { i, label ->
            val on = i == selected
            Box(
                Modifier
                    .weight(1f)
                    .height(32.dp)
                    .then(if (on) Modifier.shadow(3.dp, RoundedCornerShape(7.dp)) else Modifier)
                    .clip(RoundedCornerShape(7.dp))
                    .background(if (on) p.segOn else Color.Transparent)
                    .selectable(selected = on, role = Role.RadioButton) { onSelect(i) },
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = Type.footnote, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium, color = p.label)
            }
        }
    }
}

/** iOS-style switch. */
@Composable
fun AppSwitch(checked: Boolean) {
    val p = LocalPalette.current
    val track by animateColorAsState(if (checked) p.green else p.track, label = "track")
    val x by animateDpAsState(if (checked) 22.dp else 2.dp, label = "knob")
    Box(Modifier.size(51.dp, 31.dp).clip(RoundedCornerShape(16.dp)).background(track)) {
        Box(
            Modifier
                .offset(x = x, y = 2.dp)
                .size(27.dp)
                .shadow(3.dp, CircleShape)
                .background(Color.White, CircleShape),
        )
    }
}

@Composable
fun SwitchRow(title: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .toggleable(value = checked, role = Role.Switch, onValueChange = onChange)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = Type.body, color = p.label, modifier = Modifier.weight(1f))
        AppSwitch(checked)
    }
}

@Composable
fun SectionHeader(text: String) {
    Text(
        text.uppercase(), style = Type.footnote, color = LocalPalette.current.secondary,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 6.dp),
    )
}

@Composable
fun SectionFooter(text: String) {
    Text(
        text, style = Type.footnote, color = LocalPalette.current.secondary,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp),
    )
}

@Composable
fun GroupCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(LocalPalette.current.card),
        content = content,
    )
}

@Composable
fun RowSeparator(start: Dp = 16.dp) {
    Box(
        Modifier
            .padding(start = start)
            .fillMaxWidth()
            .height(0.5.dp)
            .background(LocalPalette.current.separator),
    )
}

@Composable
fun ValueRow(title: String, value: String) {
    val p = LocalPalette.current
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = Type.body, color = p.label, modifier = Modifier.weight(1f))
        Text(value, style = Type.body, color = p.secondary, textAlign = TextAlign.End)
    }
}

@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    background: Color = LocalPalette.current.accent,
    foreground: Color = Color.White,
) {
    val p = LocalPalette.current
    Box(
        modifier
            .fillMaxWidth()
            .height(50.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (enabled) background else p.segBg)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = Type.headline, color = if (enabled) foreground else p.secondary)
    }
}

@Composable
fun TextButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, bold: Boolean = false) {
    Box(
        modifier
            .heightIn(min = 44.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = Type.body, fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal, color = LocalPalette.current.accent)
    }
}

// ---- Small drawn icons -------------------------------------------------------

@Composable
fun CheckCircle(size: Dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        drawCircle(color)
        val s = this.size.width
        val path = Path().apply {
            moveTo(s * 0.29f, s * 0.52f)
            lineTo(s * 0.43f, s * 0.65f)
            lineTo(s * 0.71f, s * 0.37f)
        }
        drawPath(path, Color.White, style = Stroke(width = s * 0.1f, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

@Composable
fun Chevron(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(8.dp, 14.dp)) {
        val w = size.width
        val h = size.height
        val path = Path().apply {
            moveTo(w * 0.15f, h * 0.08f)
            lineTo(w * 0.85f, h * 0.5f)
            lineTo(w * 0.15f, h * 0.92f)
        }
        drawPath(path, color, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

@Composable
fun FolderIcon(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(22.dp)) {
        val s = size.width
        val path = Path().apply {
            moveTo(s * 0.12f, s * 0.3f)
            lineTo(s * 0.38f, s * 0.3f)
            lineTo(s * 0.46f, s * 0.38f)
            lineTo(s * 0.88f, s * 0.38f)
            lineTo(s * 0.88f, s * 0.8f)
            lineTo(s * 0.12f, s * 0.8f)
            close()
        }
        drawPath(path, color, style = Stroke(width = 1.8.dp.toPx(), join = StrokeJoin.Round))
    }
}

@Composable
fun WarningIcon(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(22.dp)) {
        val s = size.width
        val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        val tri = Path().apply {
            moveTo(s * 0.5f, s * 0.12f)
            lineTo(s * 0.92f, s * 0.86f)
            lineTo(s * 0.08f, s * 0.86f)
            close()
        }
        drawPath(tri, color, style = stroke)
        drawLine(color, Offset(s * 0.5f, s * 0.42f), Offset(s * 0.5f, s * 0.6f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
        drawCircle(color, radius = 1.3.dp.toPx(), center = Offset(s * 0.5f, s * 0.73f))
    }
}

@Composable
fun VSpace(h: Dp) = Spacer(Modifier.height(h))

@Composable
fun RowScope.HSpace(w: Dp) = Spacer(Modifier.width(w))
