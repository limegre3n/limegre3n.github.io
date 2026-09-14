/**
 * Film-stock dial + live film look on the viewfinder (PRD CAMERA-011 / CAMERA-012,
 * contract: docs/CONTRACTS.md §11).
 *
 * The dial only ever changes what the guest SEES and which stock id rides along in
 * the upload metadata — the JPEG that leaves the phone is always the clean
 * re-encoded original. The server develops the real look (CONTRACTS §11), so a
 * re-grade never needs a re-shoot.
 *
 * Kept deliberately cheap for low-end Android: one CSS filter chain on the
 * <video>, one tiled grain overlay and one radial vignette. No blur anywhere.
 * The <video> transform belongs to the zoom control — this module never touches it.
 */
import catalogue from '../../../functions/film-stocks.json';

/** Canonical catalogue (CONTRACTS §11) — six fixed ids, imported by relative path. */
export const FILM_STOCKS = Array.isArray(catalogue?.stocks) ? catalogue.stocks : [];
export const DEFAULT_STOCK_ID = 'clean';

const STORAGE_KEY = 'wc.filter';
/** Scroll settle before the centred swatch becomes the selection. */
const SCROLL_SETTLE_MS = 110;
/** Mirrors the landscape grip-strip query in guest.css: the dial turns vertical. */
const LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 560px)';

/** Module-level truth so the shutter handler can read the stock without the dial. */
let selectedId = null;

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    node.setAttribute(k, v === true ? '' : v);
  }
  if (text !== undefined) node.textContent = text; // textContent only (CONTRACTS §9)
  return node;
}

export function stockById(id) {
  return FILM_STOCKS.find((s) => s.id === id)
    || FILM_STOCKS.find((s) => s.id === DEFAULT_STOCK_ID)
    || { id: DEFAULT_STOCK_ID, name: 'Clean', css: { filter: 'none', grain: 0, vignette: 0 } };
}

function readStoredStockId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && FILM_STOCKS.some((s) => s.id === raw)) return raw;
  } catch { /* storage blocked — fall through to the default */ }
  return DEFAULT_STOCK_ID;
}

function writeStoredStockId(id) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* preference only */ }
}

/** The stock id the next shot should be tagged with (CAMERA-011). */
export function currentStockId() {
  if (selectedId === null) selectedId = readStoredStockId();
  return selectedId;
}

/** Minutes to ADD to UTC for this phone's local time, at SHOT time (CONTRACTS §11). */
export function tzOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

/** `'YY M D` — apostrophe, 2-digit year, unpadded month and day (CONTRACTS §11). */
export function dateStampText(date = new Date()) {
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  return `'${yy} ${date.getMonth() + 1} ${date.getDate()}`;
}

function haptic() {
  try { navigator.vibrate?.(8); } catch { /* unsupported */ }
}

/* ------------------------------------------------------- preview layers */

/**
 * Paints one stock onto the live viewfinder: the CSS approximation on the video
 * (filter only — the zoom control owns `transform`), plus grain and vignette
 * layers whose opacity comes straight from the catalogue.
 */
function applyLook(stock, { video, grain, vignette }) {
  const look = stock.css || {};
  if (video) video.style.filter = look.filter && look.filter !== 'none' ? look.filter : '';
  if (grain) {
    grain.style.opacity = String(look.grain || 0);
    grain.hidden = !look.grain;
  }
  if (vignette) {
    vignette.style.opacity = String(look.vignette || 0);
    vignette.hidden = !look.vignette;
  }
}

/* ------------------------------------------------------------ the dial */

function buildItem(stock, index) {
  const item = el('button', {
    type: 'button',
    class: 'film__item',
    role: 'radio',
    'aria-checked': 'false',
    tabindex: '-1',
    'data-stock': stock.id,
    'data-index': String(index),
  });
  const swatch = el('span', { class: 'film__swatch', 'aria-hidden': 'true' });
  // The sample gradient is fixed (skin / sky / foliage) so the stocks are
  // compared against the same subject, exactly like a film-stock chart.
  swatch.style.filter = stock.css?.filter && stock.css.filter !== 'none' ? stock.css.filter : '';
  item.append(swatch, el('span', { class: 'film__name label-caps' }, stock.name));
  return item;
}

function midpointOf(item, vertical) {
  return vertical
    ? item.offsetTop + item.offsetHeight / 2
    : item.offsetLeft + item.offsetWidth / 2;
}

function nearestIndex(scroller, items, vertical) {
  const centre = vertical
    ? scroller.scrollTop + scroller.clientHeight / 2
    : scroller.scrollLeft + scroller.clientWidth / 2;
  let best = 0;
  let bestDistance = Infinity;
  items.forEach((item, i) => {
    const distance = Math.abs(midpointOf(item, vertical) - centre);
    if (distance < bestDistance) { bestDistance = distance; best = i; }
  });
  return best;
}

/**
 * Mounts the film dial and the preview layers (CAMERA-011).
 *
 * @param {object} parts
 * @param {HTMLElement} parts.host   the viewfinder root; the dial is inserted here
 * @param {HTMLElement} parts.stage  the frame area that carries the preview layers
 * @param {HTMLVideoElement} parts.video
 * @param {HTMLElement} [parts.before] insert the dial before this node (the chassis)
 * @returns {{ id: string, destroy: () => void }}
 */
export function mountFilm({ host, stage, video, before = null }) {
  const cleanups = [];
  const grain = el('div', { class: 'film-grain', 'aria-hidden': 'true' });
  const vignette = el('div', { class: 'film-vignette', 'aria-hidden': 'true' });
  stage.append(vignette, grain);

  const wrap = el('div', { class: 'film' });
  const title = el('p', { class: 'film__title label-caps' });
  const dial = el('div', { class: 'film__dial', role: 'radiogroup', 'aria-label': 'Film stock' });
  wrap.append(title, el('span', { class: 'film__notch', 'aria-hidden': 'true' }), dial);

  const items = FILM_STOCKS.map(buildItem);
  dial.append(...items);
  if (before && before.parentElement === host) host.insertBefore(wrap, before);
  else host.append(wrap);

  const landscape = globalThis.matchMedia?.(LANDSCAPE_QUERY) || { matches: false };
  const isVertical = () => landscape.matches === true;

  let index = Math.max(0, FILM_STOCKS.findIndex((s) => s.id === currentStockId()));
  let settleTimer = null;
  let scrollingTo = false;

  function centreSelected(smooth) {
    const item = items[index];
    if (!item) return;
    const vertical = isVertical();
    const target = midpointOf(item, vertical)
      - (vertical ? dial.clientHeight : dial.clientWidth) / 2;
    scrollingTo = true;
    dial.scrollTo({
      [vertical ? 'top' : 'left']: Math.max(0, target),
      behavior: smooth ? 'smooth' : 'auto',
    });
    // The smooth scroll keeps firing 'scroll' for a while; the settle handler
    // would then re-pick the same item, which is harmless but pointless.
    setTimeout(() => { scrollingTo = false; }, SCROLL_SETTLE_MS * 4);
  }

  function paint() {
    const stock = stockById(FILM_STOCKS[index]?.id);
    items.forEach((item, i) => {
      const on = i === index;
      item.setAttribute('aria-checked', String(on));
      item.tabIndex = on ? 0 : -1;
    });
    title.textContent = `Film · ${stock.name}`;
    applyLook(stock, { video, grain, vignette });
  }

  function select(next, { scroll = true, smooth = true, announce = true } = {}) {
    const clamped = Math.min(items.length - 1, Math.max(0, next));
    const changed = clamped !== index;
    index = clamped;
    selectedId = FILM_STOCKS[index]?.id || DEFAULT_STOCK_ID;
    writeStoredStockId(selectedId);
    paint();
    if (changed && announce) haptic();
    if (scroll) centreSelected(smooth);
  }

  function onScroll() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (scrollingTo) return;
      const next = nearestIndex(dial, items, isVertical());
      if (next !== index) select(next, { scroll: false });
    }, SCROLL_SETTLE_MS);
  }

  function onClick(event) {
    const item = event.target.closest?.('.film__item');
    if (!item) return;
    select(Number(item.dataset.index) || 0);
  }

  function onKeyDown(event) {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (step === undefined && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : index + step;
    select(next);
    items[index]?.focus();
  }

  dial.addEventListener('scroll', onScroll, { passive: true });
  dial.addEventListener('click', onClick);
  dial.addEventListener('keydown', onKeyDown);
  cleanups.push(() => {
    dial.removeEventListener('scroll', onScroll);
    dial.removeEventListener('click', onClick);
    dial.removeEventListener('keydown', onKeyDown);
    clearTimeout(settleTimer);
  });

  // The dial is built before the view is in the document, so the first centring
  // waits for layout — and repeats whenever the strip changes orientation/size.
  select(index, { scroll: false, announce: false });
  const frame = requestAnimationFrame(() => centreSelected(false));
  cleanups.push(() => cancelAnimationFrame(frame));

  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => centreSelected(false));
    ro.observe(dial);
    cleanups.push(() => ro.disconnect());
  }

  return {
    get id() { return selectedId; },
    destroy() {
      for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
      wrap.remove();
      grain.remove();
      vignette.remove();
      if (video) video.style.filter = '';
    },
  };
}

/* -------------------------------------------------- date-stamp preview */

/**
 * The quartz date-back print in the corner of the frame (CAMERA-012). Preview
 * only — the capture path draws the video, never the DOM, so this is never
 * baked into the JPEG; the server burns the real stamp (CONTRACTS §11).
 *
 * @param {HTMLElement} stage
 * @param {() => boolean} isEnabled  config/event.dateStamp !== false
 */
export function mountDateStamp(stage, isEnabled) {
  const node = el('span', { class: 'film-stamp', 'aria-hidden': 'true' });
  stage.append(node);

  function update() {
    const on = isEnabled() !== false;
    node.hidden = !on;
    if (on) node.textContent = dateStampText();
  }

  update();
  return { update, destroy() { node.remove(); } };
}
