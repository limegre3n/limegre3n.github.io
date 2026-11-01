package io.github.limegre3n.heif2jpeg

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Filter { All, Heif, Raw }

data class LibraryState(
    val treeUri: Uri? = null,
    val folderName: String = "",
    val photos: List<Photo> = emptyList(),
    val selected: Set<Uri> = emptySet(),
    val filter: Filter = Filter.All,
    val loading: Boolean = false,
    val error: String? = null,
) {
    val visible: List<Photo>
        get() = when (filter) {
            Filter.All -> photos
            Filter.Heif -> photos.filter { it.kind == PhotoKind.HEIF }
            Filter.Raw -> photos.filter { it.kind == PhotoKind.RAW }
        }
    val selectedPhotos: List<Photo> get() = photos.filter { it.uri in selected }
    val totalBytes: Long get() = photos.sumOf { it.size }
}

class LibraryViewModel(app: Application) : AndroidViewModel(app) {
    private val _state = MutableStateFlow(LibraryState())
    val state: StateFlow<LibraryState> = _state

    private val _settings = MutableStateFlow(SettingsStore.load(app))
    val settings: StateFlow<Settings> = _settings

    init {
        app.contentResolver.persistedUriPermissions.lastOrNull { it.isWritePermission }?.let { open(it.uri) }
    }

    fun onFolderPicked(uri: Uri) {
        val resolver = getApplication<Application>().contentResolver
        runCatching {
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        // Keep only the newest folder grant.
        resolver.persistedUriPermissions.filter { it.uri != uri }.forEach {
            runCatching { resolver.releasePersistableUriPermission(it.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        }
        open(uri)
    }

    fun refresh() {
        _state.value.treeUri?.let { open(it, keepSelection = false) }
    }

    private fun open(uri: Uri, keepSelection: Boolean = false) {
        _state.update { it.copy(treeUri = uri, folderName = FolderAccess.folderName(uri), loading = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { FolderAccess.list(getApplication<Application>().contentResolver, uri) }
            }
            _state.update { s ->
                result.fold(
                    onSuccess = { listing ->
                        val uris = listing.photos.map { it.uri }.toSet()
                        s.copy(
                            photos = listing.photos, loading = false,
                            selected = if (keepSelection) s.selected.intersect(uris) else uris,
                        )
                    },
                    onFailure = { s.copy(photos = emptyList(), selected = emptySet(), loading = false, error = "Can't read this folder. Choose it again.") },
                )
            }
        }
    }

    fun toggle(photo: Photo) = _state.update {
        it.copy(selected = if (photo.uri in it.selected) it.selected - photo.uri else it.selected + photo.uri)
    }

    fun setFilter(f: Filter) = _state.update { it.copy(filter = f) }

    /** Select all visible photos, or deselect them if all are already selected. */
    fun toggleAllVisible() = _state.update { s ->
        val vis = s.visible.map { it.uri }.toSet()
        if (vis.isNotEmpty() && s.selected.containsAll(vis)) s.copy(selected = s.selected - vis)
        else s.copy(selected = s.selected + vis)
    }

    fun updateSettings(f: (Settings) -> Settings) {
        _settings.update(f)
        SettingsStore.save(getApplication(), _settings.value)
    }

    /** Hands the selected photos to the conversion service. [keepOriginals] overrides "Replace originals" for this run. */
    fun startConversion(keepOriginals: Boolean = false) {
        val s = _state.value
        val tree = s.treeUri ?: return
        val photos = s.selectedPhotos
        if (photos.isEmpty()) return
        JobTracker.start(
            JobState(
                treeUri = tree, folderName = s.folderName,
                settings = if (keepOriginals) _settings.value.copy(replaceOriginals = false) else _settings.value,
                items = photos.map { JobItem(it) }, startedAtMs = System.currentTimeMillis(),
            ),
        )
        ConversionService.start(getApplication())
    }
}
