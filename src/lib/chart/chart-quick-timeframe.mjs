// TYPE A TIMEFRAME.
//
// Type "5" on the chart and press Enter and you get five-minute bars — the entry every professional
// platform has, and the fastest way there is to change resolution.
//
// IT RESOLVES THROUGH THE EXISTING REGISTRY. A typed number is turned into a timeframe ID that
// chart-source.mjs already defines; there is no second table of resolutions to drift out of step
// with the first, and a number with no timeframe behind it is refused rather than guessed at.
//
// Minutes are the unit, which is the convention every trading platform uses: 60 is an hour, 240 is
// four hours. Nothing here invents a resolution the registry does not have.

import { TIMEFRAMES, timeframe, unavailableReason } from './chart-source.mjs';

/** Typed minutes → the registry ID that means that many minutes. */
export const MINUTES_TO_ID = {
  1: '1m', 2: '2m', 3: '3m', 5: '5m', 10: '10m', 15: '15m', 30: '30m', 45: '45m',
  60: '1h', 120: '2h', 180: '3h', 240: '4h',
};

/** Every number the entry accepts, for the hint under the box. */
export const ACCEPTED_MINUTES = Object.keys(MINUTES_TO_ID).map(Number).sort((a, b) => a - b);

/**
 * What a typed string means.
 *
 * Returns one of:
 *   { ok: true, id }                 a supported timeframe, ready to apply
 *   { ok: false, reason }            a real timeframe the current feed cannot serve, or no match
 *
 * A TIMEFRAME THE PROVIDER CANNOT SERVE IS REFUSED WITH ITS OWN REASON — the same honest message the
 * dropdown shows — rather than being applied and quietly drawing nothing.
 */
export function resolveTypedTimeframe(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: null };
  if (!/^\d{1,4}$/.test(text)) return { ok: false, reason: `“${text}” is not a timeframe` };

  const minutes = Number(text);
  const id = MINUTES_TO_ID[minutes];
  if (!id) return { ok: false, reason: `${minutes} minutes is not one of our timeframes` };

  const tf = timeframe(id);
  if (!tf) return { ok: false, reason: `${minutes} minutes is not one of our timeframes` };

  const why = unavailableReason(id);
  if (why) return { ok: false, reason: why, id };

  return { ok: true, id, label: tf.label };
}

/**
 * Should a keystroke open the timeframe box?
 *
 * ONLY A BARE DIGIT, and only when the keystroke is not already going somewhere that wants it. The
 * exclusions are the whole point: typing "5" into the symbol search, an indicator's period box, a
 * note, or any other field must reach that field. A scanner that steals your keystrokes is worse
 * than one with no shortcut at all.
 */
export function shouldOpenQuickTimeframe(event, target) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!/^[0-9]$/.test(event.key)) return false;
  return !isTypingTarget(target);
}

/**
 * A bare LETTER starts a symbol search, the way a trading terminal does.
 *
 * ⚠️ LETTERS ONLY — DIGITS STAY WITH THE TIMEFRAME BOX. Both cannot own the number row, and a bare
 * digit already means "change the interval" here. US equity tickers do not begin with a digit, so
 * letters lose nothing by ceding it, and once the search is open its input takes every subsequent
 * keystroke including digits — so "BRK.B" or a name with a number in it still types normally.
 *
 * ⚠️ AND IT SHADOWS THE SINGLE-LETTER CHART SHORTCUTS BY DESIGN. r/l/f/c were reset-view,
 * log-scale, fullscreen and chart-type. A terminal where typing the first letter of a ticker
 * toggles the chart type instead is the behaviour this replaces; every one of those four is a
 * labelled item in the chart menus, so nothing became unreachable, it just stopped being a bare
 * keystroke. The caller decides whether to enable this at all.
 *
 * The same exclusions as the digit gate: a keystroke inside a field belongs to that field.
 */
export function shouldOpenSymbolSearch(event, target) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!/^[A-Za-z]$/.test(event.key)) return false;
  return !isTypingTarget(target);
}

/** Is this element one that a keystroke belongs to? */
export function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
  // contenteditable is the one people forget, and it is how a rich note editor would arrive later.
  if (el.isContentEditable === true) return true;
  if (typeof el.closest === 'function' && el.closest('[contenteditable="true"]')) return true;
  return false;
}

/** How long an abandoned entry stays on screen before it gives up and closes itself. */
export const QUICK_TIMEFRAME_TIMEOUT_MS = 2500;

/** The registry IDs the entry can reach, so a test can prove the map is not inventing any. */
export const REACHABLE_IDS = Object.values(MINUTES_TO_ID);
export const ALL_TIMEFRAME_IDS = TIMEFRAMES.map((t) => t.id);
