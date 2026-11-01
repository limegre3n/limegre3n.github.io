package io.github.limegre3n.heif2jpeg.ui

import android.graphics.Bitmap
import android.graphics.Point
import android.net.Uri
import android.provider.DocumentsContract
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.limegre3n.heif2jpeg.Filter
import io.github.limegre3n.heif2jpeg.LibraryState
import io.github.limegre3n.heif2jpeg.Photo
import io.github.limegre3n.heif2jpeg.PhotoKind
import io.github.limegre3n.heif2jpeg.Settings
import io.github.limegre3n.heif2jpeg.formatBytes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val thumbCache = object : LruCache<Uri, Bitmap>(48 * 1024 * 1024) {
    override fun sizeOf(key: Uri, value: Bitmap) = value.byteCount
}

private val tones = listOf(
    0xFF7D8F86, 0xFFC9A27E, 0xFF5E6E85, 0xFFA8B4A0, 0xFF8C6A5C, 0xFFD7C9B5,
    0xFF4F5D52, 0xFFB88C6E, 0xFF9AA7B8, 0xFF6B5F70, 0xFFC4B39A, 0xFF3F4A5C,
).map { Color(it) }

@Composable
fun LibraryScreen(
    state: LibraryState,
    settings: Settings,
    onPickFolder: () -> Unit,
    onToggle: (Photo) -> Unit,
    onToggleAll: () -> Unit,
    onFilter: (Filter) -> Unit,
    onOpenOptions: () -> Unit,
    onConvert: () -> Unit,
) {
    val p = LocalPalette.current
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val visible = state.visible
    val allVisibleSelected = visible.isNotEmpty() && visible.all { it.uri in state.selected }
    val count = state.selected.size

    Box(Modifier.fillMaxSize().background(p.bg)) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = top, bottom = bottom + 150.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column {
                    Row(
                        Modifier.fillMaxWidth().height(44.dp),
                        horizontalArrangement = Arrangement.End,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (visible.isNotEmpty()) {
                            TextButton(if (allVisibleSelected) "Deselect All" else "Select All", onToggleAll)
                        }
                    }
                    Text("Convert", style = Type.largeTitle, color = p.label)
                    VSpace(14.dp)
                    FolderCard(state, onPickFolder)
                    if (state.photos.isNotEmpty()) {
                        VSpace(14.dp)
                        val heif = state.photos.count { it.kind == PhotoKind.HEIF }
                        val raw = state.photos.size - heif
                        SegmentedControl(
                            listOf("All  ${state.photos.size}", "HEIF  $heif", "RAW  $raw"),
                            state.filter.ordinal,
                            { onFilter(Filter.entries[it]) },
                        )
                    }
                    VSpace(14.dp)
                }
            }
            if (state.treeUri != null && !state.loading && state.photos.isEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    Text(
                        state.error ?: "No HEIF or ARW photos in this folder.",
                        style = Type.subhead, color = p.secondary,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 24.dp),
                    )
                }
            }
            items(visible, key = { it.uri.toString() }) { photo ->
                PhotoTile(photo, photo.uri in state.selected) { onToggle(photo) }
            }
        }

        // Bottom bar
        if (state.treeUri != null) {
            Column(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(p.bar)
                    .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = bottom + 12.dp),
            ) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .clickable(role = Role.Button, onClick = onOpenOptions)
                        .padding(horizontal = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Output", style = Type.footnote, color = p.secondary)
                        Text("${settings.format.label} · ${settings.preset.name}", style = Type.headline, color = p.label)
                    }
                    if (count > 0) {
                        Text("≈ ${formatBytes(settings.estimateBytes(state.selectedPhotos))}", style = Type.subhead, color = p.secondary)
                        HSpace(8.dp)
                    }
                    Chevron(p.secondary)
                }
                VSpace(8.dp)
                PrimaryButton(
                    if (count == 0) "Select Photos" else "Convert $count ${if (count == 1) "Photo" else "Photos"}",
                    onConvert, enabled = count > 0,
                )
            }
        }
    }
}

@Composable
private fun FolderCard(state: LibraryState, onPickFolder: () -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(p.card)
            .clickable(role = Role.Button, onClick = onPickFolder)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(p.accentSoft),
            contentAlignment = Alignment.Center,
        ) { FolderIcon(p.accent) }
        HSpace(12.dp)
        Column(Modifier.weight(1f)) {
            if (state.treeUri == null) {
                Text("Choose a folder", style = Type.headline, color = p.label)
                Text("Pick the folder with your HEIF or ARW photos", style = Type.footnote, color = p.secondary)
            } else {
                Text(state.folderName, style = Type.headline, color = p.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    if (state.loading) "Loading…" else "${state.photos.size} photos · ${formatBytes(state.totalBytes)}",
                    style = Type.footnote, color = p.secondary,
                )
            }
        }
        Text(if (state.treeUri == null) "Choose" else "Change", style = Type.subhead, color = p.accent)
    }
}

@Composable
private fun PhotoTile(photo: Photo, selected: Boolean, onToggle: () -> Unit) {
    val p = LocalPalette.current
    val context = LocalContext.current
    val thumb by produceState<ImageBitmap?>(thumbCache.get(photo.uri)?.asImageBitmap(), photo.uri) {
        if (value == null) {
            value = withContext(Dispatchers.IO) {
                runCatching {
                    DocumentsContract.getDocumentThumbnail(context.contentResolver, photo.uri, Point(320, 320), null)
                }.getOrNull()?.also { thumbCache.put(photo.uri, it) }?.asImageBitmap()
            }
        }
    }
    val tone = tones[Math.floorMod(photo.name.hashCode(), tones.size)]
    Box(
        Modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(4.dp))
            .background(tone)
            .toggleable(value = selected, role = Role.Checkbox, onValueChange = { onToggle() })
            .semantics { contentDescription = photo.name },
    ) {
        thumb?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
        if (selected) {
            Box(Modifier.fillMaxSize().background(Color.White.copy(alpha = 0.18f)).border(3.dp, p.accent))
        }
        Text(
            photo.kind.badge, style = Type.caption, color = Color.White,
            modifier = Modifier
                .align(Alignment.BottomStart)
                .padding(6.dp)
                .clip(RoundedCornerShape(5.dp))
                .background(Color.Black.copy(alpha = 0.55f))
                .padding(horizontal = 6.dp, vertical = 2.dp),
        )
        Box(Modifier.align(Alignment.BottomEnd).padding(6.dp)) {
            if (selected) {
                Box(Modifier.size(22.dp).border(1.5.dp, Color.White, CircleShape)) { CheckCircle(22.dp, p.accent) }
            } else {
                Box(Modifier.size(22.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.15f)).border(1.5.dp, Color.White, CircleShape))
            }
        }
        if (thumb == null) {
            Text(
                photo.name.substringBeforeLast('.'), style = Type.caption, fontWeight = FontWeight.Medium,
                color = Color.White.copy(alpha = 0.9f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.align(Alignment.TopStart).padding(6.dp),
            )
        }
    }
}
