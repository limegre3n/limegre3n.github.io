package io.github.limegre3n.heif2jpeg

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.limegre3n.heif2jpeg.ui.AppTheme
import io.github.limegre3n.heif2jpeg.ui.DoneScreen
import io.github.limegre3n.heif2jpeg.ui.LibraryScreen
import io.github.limegre3n.heif2jpeg.ui.OptionsSheet
import io.github.limegre3n.heif2jpeg.ui.ProgressScreen
import io.github.limegre3n.heif2jpeg.ui.ReplaceConfirmDialog

class MainActivity : ComponentActivity() {

    private val vm: LibraryViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { AppTheme { App() } }
    }

    @Composable
    private fun App() {
        val library by vm.state.collectAsStateWithLifecycle()
        val settings by vm.settings.collectAsStateWithLifecycle()
        val job by JobTracker.state.collectAsStateWithLifecycle()
        var showOptions by remember { mutableStateOf(false) }
        var showConfirm by remember { mutableStateOf(false) }
        var keepOriginals by remember { mutableStateOf(false) }

        val pickFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
            if (uri != null) vm.onFolderPicked(uri)
        }
        val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            vm.startConversion(keepOriginals)
        }
        val start = { keep: Boolean ->
            keepOriginals = keep
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                vm.startConversion(keep)
            }
        }

        val current = job
        when {
            current != null && !current.finished -> ProgressScreen(current) { ConversionService.stop(this) }
            current != null -> DoneScreen(
                current,
                onOpenFolder = { openFolder(current) },
                onConvertMore = {
                    JobTracker.clear()
                    vm.refresh()
                },
            )
            else -> LibraryScreen(
                state = library,
                settings = settings,
                onPickFolder = { pickFolder.launch(library.treeUri) },
                onToggle = vm::toggle,
                onToggleAll = vm::toggleAllVisible,
                onFilter = vm::setFilter,
                onOpenOptions = { showOptions = true },
                onConvert = { if (settings.replaceOriginals) showConfirm = true else start(false) },
            )
        }

        if (showOptions && current == null) {
            OptionsSheet(settings, library.selectedPhotos, vm::updateSettings) { showOptions = false }
        }
        if (showConfirm && current == null) {
            ReplaceConfirmDialog(
                library.selectedPhotos, settings.format.label,
                onDelete = {
                    showConfirm = false
                    start(false)
                },
                onKeep = {
                    showConfirm = false
                    start(true)
                },
                onCancel = { showConfirm = false },
            )
        }
    }

    private fun openFolder(job: JobState) {
        val dir = DocumentsContract.buildDocumentUriUsingTree(job.treeUri, DocumentsContract.getTreeDocumentId(job.treeUri))
        val intents = listOf(
            Intent(Intent.ACTION_VIEW).setDataAndType(dir, DocumentsContract.Document.MIME_TYPE_DIR),
            Intent(Intent.ACTION_VIEW).setDataAndType(dir, "resource/folder"),
        )
        for (i in intents) {
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            if (runCatching { startActivity(i) }.isSuccess) return
        }
        Toast.makeText(this, "Open the Files app to see ${job.folderName}", Toast.LENGTH_LONG).show()
    }
}
