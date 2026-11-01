package io.github.limegre3n.heif2jpeg.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.limegre3n.heif2jpeg.ItemStatus
import io.github.limegre3n.heif2jpeg.JobState
import io.github.limegre3n.heif2jpeg.JobTracker
import io.github.limegre3n.heif2jpeg.PhotoKind
import io.github.limegre3n.heif2jpeg.formatDuration
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

@Composable
fun ProgressScreen(job: JobState, onStop: () -> Unit) {
    val p = LocalPalette.current
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(500)
            now = System.currentTimeMillis()
        }
    }
    val est = JobTracker.estimate(job, now)
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val current = job.items.getOrNull(job.currentIndex)
    val percent = (est.overall * 100).toInt()
    val elapsed = (now - job.startedAtMs) / 1000.0
    val finishAt = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(now + (est.secondsLeft * 1000).toLong()))

    Column(Modifier.fillMaxSize().background(p.bg).padding(top = top, bottom = bottom + 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Box(Modifier.fillMaxWidth().height(44.dp), contentAlignment = Alignment.Center) {
                Text("Converting", style = Type.headline, color = p.label)
            }

            // Ring
            Column(Modifier.fillMaxWidth().padding(top = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier.size(168.dp).semantics { contentDescription = "$percent percent complete" },
                    contentAlignment = Alignment.Center,
                ) {
                    Canvas(Modifier.fillMaxSize()) {
                        val w = 12.dp.toPx()
                        drawCircle(p.track, radius = size.minDimension / 2 - w / 2, style = Stroke(w))
                        drawArc(
                            p.accent, startAngle = -90f, sweepAngle = (360 * est.overall).toFloat(), useCenter = false,
                            topLeft = androidx.compose.ui.geometry.Offset(w / 2, w / 2),
                            size = androidx.compose.ui.geometry.Size(size.width - w, size.height - w),
                            style = Stroke(w, cap = StrokeCap.Round),
                        )
                    }
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("$percent%", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = p.label)
                        Text("complete", style = Type.footnote, color = p.secondary)
                    }
                }
                VSpace(12.dp)
                Text(
                    when {
                        job.stopRequested -> "Stopping after this photo…"
                        current != null -> current.photo.name
                        else -> "Starting…"
                    },
                    style = Type.subhead, fontWeight = FontWeight.SemiBold, color = p.label,
                )
                Text(
                    when {
                        current == null -> " "
                        current.photo.kind == PhotoKind.RAW -> "Developing RAW → ${job.settings.format.label}"
                        else -> "HEIF → ${job.settings.format.label}"
                    },
                    style = Type.footnote, color = p.secondary,
                )
            }

            // Stat cards
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                StatCard("Done", "${job.processed}", p.green, Modifier.weight(1f)) { CheckCircle(14.dp, p.green) }
                StatCard("Remaining", "${job.remaining}", p.label, Modifier.weight(1f)) {
                    Canvas(Modifier.size(14.dp)) { drawCircle(p.secondary, radius = size.minDimension / 2 - 1.2.dp.toPx(), style = Stroke(2.4.dp.toPx())) }
                }
                StatCard(
                    "Time left",
                    if (est.rough && job.processed == 0 && est.activeFraction < 0.3) "~${formatDuration(est.secondsLeft)}" else formatDuration(est.secondsLeft),
                    p.accent, Modifier.weight(1f),
                ) {
                    Canvas(Modifier.size(14.dp)) {
                        val r = size.minDimension / 2 - 1.2.dp.toPx()
                        drawCircle(p.accent, radius = r, style = Stroke(2.4.dp.toPx()))
                        drawLine(p.accent, center, center.copy(y = center.y - r * 0.6f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
                        drawLine(p.accent, center, center.copy(x = center.x + r * 0.5f, y = center.y + r * 0.3f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
                    }
                }
            }

            // Per-photo bar
            Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp)) {
                SegmentBar(job, est.activeFraction)
                VSpace(8.dp)
                Row(Modifier.fillMaxWidth()) {
                    Text(
                        "${job.processed} of ${job.total} photos · ${formatDuration(elapsed)} elapsed",
                        style = Type.footnote, color = p.secondary, modifier = Modifier.weight(1f),
                    )
                    Text("Done ≈ $finishAt", style = Type.footnote, color = p.secondary)
                }
                if (job.failed > 0) {
                    VSpace(4.dp)
                    Text("${job.failed} couldn't be converted (details at the end)", style = Type.footnote, color = p.orange)
                }
            }

            // Up next
            Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 18.dp)) {
                SectionHeader("Up next")
                val start = (job.currentIndex - 1).coerceIn(0, Math.max(0, job.total - 3))
                val rows = job.items.drop(start).take(3)
                GroupCard {
                    rows.forEachIndexed { k, item ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(item.photo.name, style = Type.subhead, color = p.label, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            when (item.status) {
                                ItemStatus.Done -> CheckCircle(20.dp, p.green, Modifier.semantics { contentDescription = "Done" })
                                ItemStatus.Failed -> Text("Failed", style = Type.footnote, color = p.orange)
                                ItemStatus.Active -> Text("${(est.activeFraction * 100).toInt()}%", style = Type.subhead, color = p.accent)
                                ItemStatus.Skipped -> Text("Skipped", style = Type.footnote, color = p.secondary)
                                ItemStatus.Waiting -> {
                                    val wait = waitSeconds(job, start + k, now)
                                    Text("in ~${shortDuration(wait)}", style = Type.footnote, color = p.secondary)
                                }
                            }
                        }
                        if (k < rows.size - 1) RowSeparator()
                    }
                }
            }
        }

        Box(Modifier.padding(horizontal = 16.dp)) {
            PrimaryButton(
                if (job.stopRequested) "Stopping…" else "Stop", onStop,
                enabled = !job.stopRequested, background = p.segBg, foreground = p.red,
            )
        }
    }
}

@Composable
private fun StatCard(label: String, value: String, valueColor: Color, modifier: Modifier, icon: @Composable () -> Unit) {
    val p = LocalPalette.current
    Column(
        modifier.clip(RoundedCornerShape(12.dp)).background(p.card).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            icon()
            HSpace(5.dp)
            Text(label, style = Type.footnote, color = p.secondary, maxLines = 1)
        }
        Text(value, fontSize = if (value.length > 6) 20.sp else 28.sp, fontWeight = FontWeight.Bold, color = valueColor, maxLines = 1)
    }
}

/** One segment per photo (green done, blue filling = active, grey waiting); a single bar for big batches. */
@Composable
private fun SegmentBar(job: JobState, activeFraction: Double) {
    val p = LocalPalette.current
    val desc = "${job.processed} of ${job.total} photos converted, ${job.remaining} remaining"
    if (job.total <= 40) {
        Row(Modifier.fillMaxWidth().semantics { contentDescription = desc }, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            job.items.forEach { item ->
                val fill = when (item.status) {
                    ItemStatus.Done -> 1f
                    ItemStatus.Failed -> 1f
                    ItemStatus.Active -> activeFraction.toFloat()
                    else -> 0f
                }
                val color = when (item.status) {
                    ItemStatus.Done -> p.green
                    ItemStatus.Failed -> p.orange
                    else -> p.accent
                }
                Box(Modifier.weight(1f).height(8.dp).clip(RoundedCornerShape(4.dp)).background(p.track)) {
                    if (fill > 0f) Box(Modifier.fillMaxHeight().fillMaxWidth(fill).clip(RoundedCornerShape(4.dp)).background(color))
                }
            }
        }
    } else {
        val doneFrac = job.processed.toFloat() / job.total
        val activeFrac = (activeFraction / job.total).toFloat()
        Box(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)).background(p.track).semantics { contentDescription = desc }) {
            Box(Modifier.fillMaxHeight().fillMaxWidth((doneFrac + activeFrac).coerceAtMost(1f)).background(p.accent))
            Box(Modifier.fillMaxHeight().fillMaxWidth(doneFrac).background(p.green))
        }
    }
}

private fun waitSeconds(job: JobState, index: Int, now: Long): Double {
    var s = 0.0
    for (i in 0 until index) {
        val item = job.items[i]
        when (item.status) {
            ItemStatus.Waiting -> s += JobTracker.expectedSeconds(job, item.photo)
            ItemStatus.Active -> s += Math.max(0.0, JobTracker.expectedSeconds(job, item.photo) - (now - job.currentStartedAtMs) / 1000.0)
            else -> Unit
        }
    }
    return s + JobTracker.expectedSeconds(job, job.items[index].photo)
}

private fun shortDuration(s: Double): String = if (s < 60) "${Math.round(s)}s" else "${Math.round(s / 60)}m"
