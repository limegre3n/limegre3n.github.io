package io.github.limegre3n.heif2jpeg.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.github.limegre3n.heif2jpeg.OutputFormat
import io.github.limegre3n.heif2jpeg.Photo
import io.github.limegre3n.heif2jpeg.Settings
import io.github.limegre3n.heif2jpeg.formatBytes

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OptionsSheet(
    settings: Settings,
    selected: List<Photo>,
    onChange: ((Settings) -> Settings) -> Unit,
    onDismiss: () -> Unit,
) {
    val p = LocalPalette.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = p.bg,
        shape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp),
        dragHandle = {
            Box(Modifier.padding(top = 6.dp).size(36.dp, 5.dp).clip(RoundedCornerShape(3.dp)).background(p.separator))
        },
    ) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = bottom + 16.dp)) {
            Box(Modifier.fillMaxWidth().height(50.dp).padding(horizontal = 16.dp)) {
                Text("Output", style = Type.headline, color = p.label, textAlign = TextAlign.Center, modifier = Modifier.align(Alignment.Center))
                TextButton("Done", onDismiss, Modifier.align(Alignment.CenterEnd), bold = true)
            }

            Column(Modifier.padding(horizontal = 16.dp)) {
                VSpace(8.dp)
                SectionHeader("Format")
                SegmentedControl(
                    OutputFormat.entries.map { it.label },
                    settings.format.ordinal,
                    { i -> onChange { it.copy(format = OutputFormat.entries[i]) } },
                )
                SectionFooter(settings.format.note)

                VSpace(22.dp)
                SectionHeader("Quality")
                GroupCard {
                    val chosen = settings.presetIndex[settings.format] ?: 0
                    settings.format.presets.forEachIndexed { i, preset ->
                        val estimate = settings.copy(presetIndex = settings.presetIndex + (settings.format to i)).estimateBytes(selected)
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 60.dp)
                                .selectable(selected = i == chosen, role = Role.RadioButton) {
                                    onChange { it.copy(presetIndex = it.presetIndex + (it.format to i)) }
                                }
                                .padding(start = 16.dp, end = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f).padding(vertical = 11.dp)) {
                                Text(preset.name, style = Type.body, color = p.label)
                                Text(preset.detail, style = Type.footnote, color = p.secondary)
                            }
                            if (selected.isNotEmpty()) {
                                Text("≈ ${formatBytes(estimate)}", style = Type.subhead, color = p.secondary)
                            }
                            Box(Modifier.width(30.dp), contentAlignment = Alignment.CenterEnd) {
                                if (i == chosen) Text("✓", style = Type.headline, color = p.accent)
                            }
                        }
                        if (i < settings.format.presets.size - 1) RowSeparator()
                    }
                }
                SectionFooter(
                    if (selected.isEmpty()) "Select photos to see estimated sizes."
                    else "Estimated total for ${selected.size} selected photos. Actual sizes depend on the photos.",
                )

                VSpace(22.dp)
                SectionHeader("Files")
                GroupCard {
                    SwitchRow("Keep metadata", settings.keepMetadata) { v -> onChange { it.copy(keepMetadata = v) } }
                    RowSeparator()
                    SwitchRow("Replace originals", settings.replaceOriginals) { v -> onChange { it.copy(replaceOriginals = v) } }
                }
                SectionFooter(
                    "Metadata is the camera, date, exposure, lens and location. The color profile is always kept. " +
                        "Originals are deleted only after their new file is saved, and you'll be asked to confirm first.",
                )
            }
        }
    }
}
