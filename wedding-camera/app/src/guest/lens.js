/**
 * Lens ladder (CAMERA-010) — pure, no DOM, no MediaDevices.
 *
 * THE PROBLEM this solves: on iOS 17+ Safari, `facingMode: environment` usually
 * hands back a VIRTUAL multi-lens device ("Back Dual Wide Camera", "Back Triple
 * Camera") whose native zoom 1.0 is the ULTRA-WIDE lens. WebKit does not
 * normalise that to the phone's main camera, so an app that shows native zoom
 * verbatim tells the guest "1×" while framing the 0.5× lens — exactly the
 * complaint we got. Android varies differently: one logical back camera with a
 * zoom range (1–8, or 0.5–10 on Samsung/Pixel where the sub-1 values ARE the
 * ultra-wide), or several discrete back cameras with no zoom range at all.
 *
 * The ladder turns whatever the browser exposes into ONE honest scale of
 * *displayed magnification* where 1× always means the phone's main wide lens.
 *
 *   buildLadder({ devices, capsById, labelsById, facing }) -> ladder
 *   resolve(ladder, mag) -> { deviceId, nativeZoom, digital }
 *   describeLadder(ladder) -> plain text (the ?diag=1 sheet)
 *
 * Every heuristic branch appends a human-readable line to `ladder.notes`; that
 * is what the couple screenshots from their own phones so we can tune this.
 */

/** A device is a back-camera candidate if its label or capabilities say so. */
const BACK_LABEL_RE = /back|rear|environment|camera2 \d+, facing back/i;
/** iOS virtual devices that INCLUDE the ultra-wide element (native 1.0 = 0.5×). */
const ULTRA_WIDE_VIRTUAL_RE = /dual wide|triple/i;
/** Labels that promise a real tele element, so a 3× rung is a real lens. */
const TELE_RE = /telephoto|triple/i;
const ULTRA_WIDE_RE = /ultra.?wide/i;

/** Native mode needs a range worth calling a range (2× and up, with slack). */
const NATIVE_RANGE_RATIO = 1.8;
/** Beyond this the picture is mush on every phone we can test; stop the slider. */
const MAX_MAGNIFICATION = 8;
/** Digital-only fallback ceiling — today's behaviour, honestly labelled. */
const DIGITAL_MAX = 2;
/** A ladder whose bottom rung is at or below this gets a printed "0.5×" tick. */
const HALF_RUNG_CEILING = 0.55;

/* ------------------------------------------------------------------ utils */

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** MediaTrackCapabilities.zoom is `{min,max,step}` on every engine that has it. */
function zoomRange(caps) {
  const zoom = caps?.zoom;
  if (!zoom || typeof zoom !== 'object') return null;
  const min = Number(zoom.min);
  const max = Number(zoom.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return null;
  return { min: min > 0 ? min : 1, max };
}

function isUsableRange(range) {
  return !!range && range.max / range.min >= NATIVE_RANGE_RATIO;
}

function labelOf(device, labelsById) {
  return String(labelsById?.[device.deviceId] || device.label || '');
}

/** Back-facing candidates only; the front camera gets its own tiny ladder. */
export function backCandidates(devices = [], capsById = {}, labelsById = {}) {
  return devices
    .filter((d) => !d.kind || d.kind === 'videoinput')
    .map((d) => ({ device: d, label: labelOf(d, labelsById), caps: capsById[d.deviceId] || {} }))
    .filter(({ device, label, caps }) => {
      if (BACK_LABEL_RE.test(label)) return true;
      const facing = caps.facingMode;
      if (Array.isArray(facing) && facing.includes('environment')) return true;
      if (typeof facing === 'string' && facing === 'environment') return true;
      return device.facing === 'environment' || device.facingMode === 'environment';
    });
}

/* ------------------------------------------------------------- front lens */

/** CAMERA-006: the selfie camera never gets lens switching — 1–2× digital. */
function frontLadder(devices, labelsById) {
  const first = devices.find((d) => !d.kind || d.kind === 'videoinput');
  return {
    mode: 'digital',
    facing: 'user',
    min: 1,
    max: DIGITAL_MAX,
    oneX: 1,
    deviceId: first?.deviceId || null,
    nativeMin: null,
    nativeMax: null,
    rungs: [
      { mag: 1, label: '1×', deviceId: first?.deviceId || null, nativeZoom: null, real: true },
      { mag: DIGITAL_MAX, label: '2×', deviceId: first?.deviceId || null, nativeZoom: null, real: false, digitalOnly: true },
    ],
    notes: ['Front camera: digital crop only, 1×–2× (no lens switching on any selfie camera).'],
  };
}

/* ------------------------------------------------------------ native mode */

/**
 * Calibrate `oneX` — the NATIVE zoom value that frames the phone's main wide
 * lens — then express everything the guest sees as `native / oneX`.
 */
function calibrateOneX(range, label, notes) {
  if (range.min < 0.95) {
    // Android (Samsung/Pixel) publishes the ultra-wide as a sub-1 zoom value on
    // the same logical camera, already normalised so 1.0 IS the main lens.
    notes.push(`Zoom range starts at ${round2(range.min)} (<0.95): Android-style `
      + 'normalised range, native 1.0 is already the main lens, so 1× = native 1.0.');
    return 1;
  }
  if (ULTRA_WIDE_VIRTUAL_RE.test(label)) {
    // iOS virtual device containing the ultra-wide. WebKit does NOT normalise:
    // native 1.0 is the 0.5× ultra-wide and the main lens sits at native 2.0.
    notes.push(`Label "${label}" is an iOS virtual multi-lens device that includes the `
      + 'ultra-wide, and WebKit does not normalise it: native 1.0 = 0.5×, so 1× = native 2.0.');
    return 2;
  }
  // "Back Camera", "Back Dual Camera" (wide+tele), Android logical camera: the
  // bottom of the range already is the main lens.
  notes.push(`Label "${label || 'unknown'}" has no ultra-wide element, so the bottom of the `
    + `range is the main lens: 1× = native ${round2(range.min)}.`);
  return range.min;
}

/** Rung set for a continuous range — real lenses first, digital stops after. */
function nativeRungs(minMag, maxMag, label, deviceId, notes) {
  const rungs = [];
  const add = (mag, text, real) => rungs.push({
    mag: round2(mag), label: text, deviceId, nativeZoom: null, real: !!real,
  });

  if (minMag <= HALF_RUNG_CEILING) {
    add(minMag, '0.5×', true);
    notes.push(`Bottom of the ladder is ${round2(minMag)}× — ultra-wide reachable, 0.5× tick shown.`);
  } else {
    notes.push(`Bottom of the ladder is ${round2(minMag)}× — no ultra-wide, no 0.5× tick.`);
  }
  add(1, '1×', true);
  if (maxMag >= 2) add(2, '2×', true);
  // A 3× tick is only honest when the label promises a tele element or the range
  // is long enough that 3× is still optically fed.
  if (maxMag >= 3 && (TELE_RE.test(label) || maxMag >= 4)) add(3, '3×', TELE_RE.test(label));
  if (maxMag >= 5) add(5, '5×', TELE_RE.test(label));
  return rungs;
}

function nativeLadder(candidate, notes) {
  const { device, label, range } = candidate;
  const oneX = calibrateOneX(range, label, notes);
  const minMag = round2(Math.max(range.min / oneX, 0.1));
  const maxMag = round2(Math.min(range.max / oneX, MAX_MAGNIFICATION));
  if (range.max / oneX > MAX_MAGNIFICATION) {
    notes.push(`Hardware reaches ${round2(range.max / oneX)}× but the slider stops at `
      + `${MAX_MAGNIFICATION}× (beyond that it is unusable mush on a phone).`);
  }
  return {
    mode: 'native',
    facing: 'environment',
    min: minMag,
    max: maxMag,
    oneX: round2(oneX),
    deviceId: device.deviceId,
    nativeMin: round2(range.min),
    nativeMax: round2(range.max),
    rungs: nativeRungs(minMag, maxMag, label, device.deviceId, notes),
    notes,
  };
}

/* ---------------------------------------------------------- discrete mode */

/** Map one back-camera label onto the magnification it actually frames. */
function discreteMagFor(label, index) {
  if (ULTRA_WIDE_RE.test(label)) return { mag: 0.5, why: 'label says ultra wide' };
  if (TELE_RE.test(label)) {
    const stated = /(\d+(?:\.\d+)?)\s*x/i.exec(label);
    if (stated) return { mag: Number(stated[1]), why: `label states ${stated[1]}×` };
    return { mag: 2, why: 'telephoto with no stated factor, assumed 2×' };
  }
  if (/back camera$|^back$|camera2 0/i.test(label.trim())) {
    return { mag: 1, why: 'default back camera' };
  }
  if (index === 0) return { mag: 1, why: 'first back device, treated as the main lens' };
  return null;
}

function discreteLadder(candidates, notes) {
  const rungs = [];
  candidates.forEach(({ device, label }, index) => {
    const hit = discreteMagFor(label, index);
    if (!hit) {
      notes.push(`Skipped back device "${label || device.deviceId.slice(0, 6)}" — `
        + 'no recognisable lens in the label, guessing would mis-frame the shot.');
      return;
    }
    if (rungs.some((r) => r.mag === hit.mag)) {
      notes.push(`Skipped duplicate ${hit.mag}× device "${label}".`);
      return;
    }
    notes.push(`"${label || device.deviceId.slice(0, 6)}" → ${hit.mag}× (${hit.why}).`);
    rungs.push({
      mag: hit.mag,
      label: `${hit.mag}×`,
      deviceId: device.deviceId,
      nativeZoom: null,
      real: true,
    });
  });
  rungs.sort((a, b) => a.mag - b.mag);
  const top = rungs[rungs.length - 1];
  const max = round2(top.mag * DIGITAL_MAX);
  notes.push(`Between lenses the lower lens is cropped digitally; above ${top.mag}× the `
    + `slider allows ${DIGITAL_MAX}× digital crop (to ${max}×), where quality drops.`);
  return {
    mode: 'discrete',
    facing: 'environment',
    min: rungs[0].mag,
    max,
    oneX: 1,
    deviceId: (rungs.find((r) => r.mag === 1) || rungs[0]).deviceId,
    nativeMin: null,
    nativeMax: null,
    rungs,
    notes,
  };
}

/* ----------------------------------------------------------- digital mode */

function digitalLadder(candidate, notes) {
  const deviceId = candidate?.device?.deviceId || null;
  notes.push('Only one back camera and no usable zoom range: digital centre-crop 1×–2× '
    + '(CAMERA-006 fallback). Quality drops across the whole range above 1×.');
  return {
    mode: 'digital',
    facing: 'environment',
    min: 1,
    max: DIGITAL_MAX,
    oneX: 1,
    deviceId,
    nativeMin: null,
    nativeMax: null,
    rungs: [
      { mag: 1, label: '1×', deviceId, nativeZoom: null, real: true },
      { mag: DIGITAL_MAX, label: '2×', deviceId, nativeZoom: null, real: false, digitalOnly: true },
    ],
    notes,
  };
}

/* --------------------------------------------------------------- builder */

/**
 * Build the ladder. `capsById` may be sparse: capabilities are only known for
 * devices we have actually opened, and camera.js probes lazily.
 */
export function buildLadder({ devices = [], capsById = {}, labelsById = {}, facing = 'environment' } = {}) {
  if (facing === 'user') return frontLadder(devices, labelsById);

  const notes = [];
  const candidates = backCandidates(devices, capsById, labelsById)
    .map((c) => ({ ...c, range: zoomRange(c.caps) }));

  if (!candidates.length) {
    notes.push('No back-facing camera identified (labels empty before the first permission '
      + 'grant, or a desktop webcam): falling back to digital crop.');
    return digitalLadder(null, notes);
  }
  notes.push(`${candidates.length} back-facing candidate(s): `
    + candidates.map((c) => `"${c.label || c.device.deviceId.slice(0, 6)}"`).join(', ') + '.');

  // NATIVE wins whenever one back device publishes a range worth using — it is
  // optical where the hardware allows and needs no stream switching.
  const zoomable = candidates.filter((c) => isUsableRange(c.range));
  if (zoomable.length) {
    const best = zoomable.reduce((a, b) => (b.range.max / b.range.min > a.range.max / a.range.min ? b : a));
    notes.push(`Native zoom range ${round2(best.range.min)}–${round2(best.range.max)} on `
      + `"${best.label || best.device.deviceId.slice(0, 6)}" (ratio ≥ ${NATIVE_RANGE_RATIO}).`);
    return nativeLadder(best, notes);
  }

  // DISCRETE: several physical back cameras, none of them zoomable.
  if (candidates.length >= 2) {
    notes.push('No back device publishes a usable zoom range but there are several: '
      + 'treating them as fixed lenses and switching streams between rungs.');
    const ladder = discreteLadder(candidates, notes);
    if (ladder.rungs.length >= 2) return ladder;
    notes.push('…only one lens could be identified after all; using digital crop.');
  }

  return digitalLadder(candidates[0], notes);
}

/* -------------------------------------------------------------- resolver */

/**
 * Map a displayed magnification onto what the hardware has to do:
 *   deviceId   — which camera must be streaming
 *   nativeZoom — the `zoom` constraint to apply (null when there is none)
 *   digital    — CSS scale + capture crop factor on top, always ≥ 1
 */
export function resolve(ladder, mag) {
  const wanted = clamp(Number(mag) || 1, ladder.min, ladder.max);

  if (ladder.mode === 'native') {
    const native = clamp(wanted * ladder.oneX, ladder.nativeMin, ladder.nativeMax);
    // Anything the range cannot reach is made up with a crop (rare: only when
    // the slider floor is below nativeMin/oneX through rounding).
    const reached = native / ladder.oneX;
    return {
      deviceId: ladder.deviceId,
      nativeZoom: round2(native),
      digital: round2(Math.max(1, wanted / reached)),
    };
  }

  if (ladder.mode === 'discrete') {
    let rung = ladder.rungs[0];
    for (const r of ladder.rungs) if (r.mag <= wanted + 1e-6) rung = r;
    return {
      deviceId: rung.deviceId,
      nativeZoom: null,
      digital: round2(Math.max(1, wanted / rung.mag)),
    };
  }

  return {
    deviceId: ladder.deviceId,
    nativeZoom: null,
    digital: round2(Math.max(1, wanted)),
  };
}

/** Snap to a rung when the guest lands within `tol` of one (CAMERA-010). */
export function snapToRung(ladder, mag, tol = 0.06) {
  let best = null;
  for (const r of ladder.rungs) {
    const d = Math.abs(r.mag - mag);
    if (d <= tol && (!best || d < Math.abs(best.mag - mag))) best = r;
  }
  return best ? best.mag : round2(clamp(mag, ladder.min, ladder.max));
}

/** The top rung fed by a real lens — beyond it the track is digital-only. */
export function opticalCeiling(ladder) {
  if (ladder.mode === 'digital') return ladder.min;
  if (ladder.mode === 'discrete') {
    const real = ladder.rungs.filter((r) => r.real);
    return real.length ? real[real.length - 1].mag : ladder.min;
  }
  return ladder.max; // native: the range itself is the ceiling
}

/** Plain text for the ?diag=1 sheet — what the couple screenshots for us. */
export function describeLadder(ladder) {
  if (!ladder) return 'ladder: (not built yet)';
  const lines = [
    `mode: ${ladder.mode}  facing: ${ladder.facing}`,
    `oneX (native value that means 1×): ${ladder.oneX}`,
    `range: ${ladder.min}× – ${ladder.max}×`,
    ladder.nativeMin != null ? `native zoom capability: ${ladder.nativeMin} – ${ladder.nativeMax}` : 'native zoom capability: none',
    `optical ceiling: ${opticalCeiling(ladder)}×`,
    'rungs:',
    ...ladder.rungs.map((r) => `  ${r.label} = mag ${r.mag}`
      + (r.deviceId ? ` dev ${String(r.deviceId).slice(0, 6)}` : '')
      + (r.real === false ? ' (digital)' : '')),
    'why:',
    ...ladder.notes.map((n) => `  - ${n}`),
  ];
  return lines.join('\n');
}

/** One line describing what `mag` currently does — live mapping for diagnostics. */
export function describeMapping(ladder, mag) {
  if (!ladder) return 'mapping: (no ladder)';
  const r = resolve(ladder, mag);
  return `mapping at ${Number(mag).toFixed(1)}×: device ${String(r.deviceId || 'default').slice(0, 6)}`
    + `, native zoom ${r.nativeZoom == null ? 'n/a' : r.nativeZoom}`
    + `, digital crop ${r.digital}×`;
}
