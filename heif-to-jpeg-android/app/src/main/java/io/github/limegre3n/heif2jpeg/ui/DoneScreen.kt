package io.github.limegre3n.heif2jpeg.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import io.github.limegre3n.heif2jpeg.ItemStatus
import io.github.limegre3n.heif2jpeg.JobState
import io.github.limegre3n.heif2jpeg.Photo
import io.github.limegre3n.heif2jpeg.PhotoKind
import io.github.limegre3n.heif2jpeg.formatBytes
import io.github.limegre3n.heif2jpeg.formatDuration

@Composable
fun DoneScreen(job: JobState, onOpenFolder: () -> Unit, onConvertMore: () -> Unit) {
    val p = LocalPalette.current
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val secs = (job.endedAtMs - job.startedAtMs) / 1000.0
    val title = when {
        job.skipped > 0 -> "Stopped"
        job.done == 0 -> "Nothing Converted"
        else -> "${job.done} ${if (job.done == 1) "Photo" else "Photos"} Converted"
    }
    val subtitle = when {
        job.skipped > 0 -> "${job.done} of ${job.total} photos were converted before you stopped."
        else -> "Saved as ${job.settings.format.label} next to the originals in ${job.folderName}."
    }
    val notes = job.items.filter { it.note != null || it.status == ItemStatus.Failed }

    Column(Modifier.fillMaxSize().background(p.bg).padding(top = top, bottom = bottom + 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Column(
                Modifier.fillMaxWidth().padding(start = 32.dp, end = 32.dp, top = 72.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                if (job.done > 0) CheckCircle(76.dp, p.green) else WarningIcon(p.orange, Modifier.width(76.dp))
                Text(title, style = Type.title2, color = p.label, textAlign = TextAlign.Center)
                Text(subtitle, style = Type.subhead, color = p.secondary, textAlign = TextAlign.Center)
            }

            Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 32.dp)) {
                GroupCard {
                    ValueRow("Output", "${job.settings.format.label} · ${job.settings.preset.name}")
                    RowSeparator()
                    ValueRow("Total size", formatBytes(job.outBytes))
                    RowSeparator()
                    ValueRow("Time", formatDuration(secs))
                    RowSeparator()
                    ValueRow(
                        "Originals",
                        if (!job.settings.replaceOriginals) "Kept" else "${job.originalsDeleted} deleted",
                    )
                    if (job.failed > 0) {
                        RowSeparator()
                        ValueRow("Failed", "${job.failed}")
                    }
                }
            }

            if (notes.isNotEmpty()) {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 22.dp)) {
                    SectionHeader(if (notes.size == 1) "1 note" else "${notes.size} notes")
                    GroupCard {
                        notes.forEachIndexed { i, item ->
                            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                                WarningIcon(if (item.status == ItemStatus.Failed) p.red else p.orange)
                                HSpace(12.dp)
                                Column {
                                    Text(item.photo.name, style = Type.subhead, fontWeight = FontWeight.SemiBold, color = p.label)
                                    Text(
                                        (if (item.status == ItemStatus.Failed) "Not converted: " else "") + (item.note ?: ""),
                                        style = Type.footnote, color = p.secondary,
                                    )
                                }
                            }
                            if (i < notes.size - 1) RowSeparator()
                        }
                    }
                }
            }
        }

        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            PrimaryButton("Open Folder", onOpenFolder)
            PrimaryButton("Convert More", onConvertMore, background = Color.Transparent, foreground = p.accent)
        }
    }
}

/** iOS-style alert confirming deletion of originals. */
@Composable
fun ReplaceConfirmDialog(photos: List<Photo>, formatLabel: String, onDelete: () -> Unit, onKeep: () -> Unit, onCancel: () -> Unit) {
    val p = LocalPalette.current
    val heif = photos.count { it.kind == PhotoKind.HEIF }
    val raw = photos.size - heif
    val parts = listOfNotNull(
        if (heif > 0) "$heif HEIF" else null,
        if (raw > 0) "$raw RAW" else null,
    ).joinToString(" and ")
    val message = buildString {
        append("$parts ${if (photos.size == 1) "file" else "files"} will be deleted after their ${formatLabel}s are saved.")
        if (raw > 0) append(" RAW files hold far more detail than any $formatLabel.")
        append(" This can't be undone.")
    }
    Dialog(onDismissRequest = onCancel) {
        Column(
            Modifier
                .width(270.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(if (p.dark) Color(0xFF2C2C2E) else Color(0xFFF2F2F7)),
        ) {
            Column(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    "Delete ${photos.size} ${if (photos.size == 1) "original" else "originals"}?",
                    style = Type.headline, color = p.label, textAlign = TextAlign.Center,
                )
                Text(message, style = Type.footnote, color = p.label, textAlign = TextAlign.Center)
            }
            AlertButton("Convert & Delete Originals", p.red, false, onDelete)
            AlertButton("Convert & Keep Originals", p.accent, false, onKeep)
            AlertButton("Cancel", p.accent, true, onCancel)
        }
    }
}

@Composable
private fun AlertButton(text: String, color: Color, bold: Boolean, onClick: () -> Unit) {
    val p = LocalPalette.current
    Box(Modifier.fillMaxWidth().background(p.separator).padding(top = 0.5.dp)) {
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .background(if (p.dark) Color(0xFF2C2C2E) else Color(0xFFF2F2F7))
                .clickable(role = Role.Button, onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Text(text, style = Type.body, fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal, color = color)
        }
    }
}
