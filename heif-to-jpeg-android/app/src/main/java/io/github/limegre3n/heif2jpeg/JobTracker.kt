package io.github.limegre3n.heif2jpeg

import android.net.Uri
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

enum class ItemStatus { Waiting, Active, Done, Failed, Skipped }

data class JobItem(
    val photo: Photo,
    val status: ItemStatus = ItemStatus.Waiting,
    val outName: String? = null,
    val outBytes: Long = 0,
    val note: String? = null,
    val originalDeleted: Boolean = false,
)

data class JobState(
    val treeUri: Uri,
    val folderName: String,
    val settings: Settings,
    val items: List<JobItem>,
    val startedAtMs: Long,
    val currentIndex: Int = -1,
    val currentStartedAtMs: Long = 0,
    val stopRequested: Boolean = false,
    val finished: Boolean = false,
    val endedAtMs: Long = 0,
    /** Measured seconds and megabytes of finished photos, per kind, for the time estimate. */
    val measured: Map<PhotoKind, Pair<Double, Double>> = emptyMap(),
) {
    val total get() = items.size
    val done get() = items.count { it.status == ItemStatus.Done }
    val failed get() = items.count { it.status == ItemStatus.Failed }
    val skipped get() = items.count { it.status == ItemStatus.Skipped }
    val processed get() = items.count { it.status == ItemStatus.Done || it.status == ItemStatus.Failed }
    val remaining get() = items.count { it.status == ItemStatus.Waiting || it.status == ItemStatus.Active }
    val outBytes get() = items.sumOf { it.outBytes }
    val originalsDeleted get() = items.count { it.originalDeleted }
}

data class Estimate(
    /** Seconds until the whole batch is done. */
    val secondsLeft: Double,
    /** Estimated progress of the photo being converted right now, 0..1. */
    val activeFraction: Double,
    /** Overall progress 0..1, counting the active photo's estimated progress. */
    val overall: Double,
    /** True until at least one photo has been timed (estimate is a first guess). */
    val rough: Boolean,
)

/** In-memory state of the current conversion job, shared by the service and the UI. */
object JobTracker {
    private val _state = MutableStateFlow<JobState?>(null)
    val state: StateFlow<JobState?> = _state

    fun start(job: JobState) {
        _state.value = job
    }

    fun update(f: (JobState) -> JobState) = _state.update { it?.let(f) }

    fun clear() {
        if (_state.value?.finished != false) _state.value = null
    }

    // Seconds per MB of source file for a JPEG conversion on a typical phone; used
    // until real photos have been timed. RAW is faster per MB because RAW files are big.
    private val prior = mapOf(PhotoKind.HEIF to 0.55, PhotoKind.RAW to 0.3)

    private fun secondsPerMb(job: JobState, kind: PhotoKind): Double {
        job.measured[kind]?.let { (s, mb) -> if (mb > 0) return s / mb }
        val factor = job.settings.format.timeFactor
        val other = PhotoKind.entries.firstOrNull { it != kind && job.measured[it] != null }
        if (other != null) {
            val (s, mb) = job.measured.getValue(other)
            if (mb > 0) return s / mb * prior.getValue(kind) / prior.getValue(other)
        }
        return prior.getValue(kind) * factor
    }

    fun expectedSeconds(job: JobState, p: Photo): Double =
        Math.max(1.0, secondsPerMb(job, p.kind) * p.size / 1e6)

    fun estimate(job: JobState, nowMs: Long): Estimate {
        if (job.finished || job.total == 0) return Estimate(0.0, 0.0, 1.0, false)
        var left = 0.0
        var activeFraction = 0.0
        job.items.forEachIndexed { i, item ->
            when (item.status) {
                ItemStatus.Waiting -> left += expectedSeconds(job, item.photo)
                ItemStatus.Active -> {
                    val exp = expectedSeconds(job, item.photo)
                    val elapsed = (nowMs - job.currentStartedAtMs) / 1000.0
                    activeFraction = (elapsed / exp).coerceIn(0.0, 0.95)
                    left += Math.max(exp * 0.05, exp - elapsed)
                }
                else -> Unit
            }
        }
        val overall = ((job.processed + job.skipped + activeFraction) / job.total).coerceIn(0.0, 1.0)
        return Estimate(left, activeFraction, overall, job.measured.isEmpty())
    }
}
