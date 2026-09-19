// LEVEL DURABILITY BY TIMEFRAME — descriptive research, not a signal.
//
// THE QUESTION: does the widely-held belief that weekly and monthly levels "carry more weight" than
// daily ones show up in our own data? The engine deliberately does NOT assume it — zones carry
// timeframe as a property and MAJOR is a list of named criteria, never Monthly=3/Weekly=2/Daily=1.
// This harness is how that belief gets tested instead of asserted.
//
// ── THE METHOD IS POINT-IN-TIME OR IT IS NOTHING ────────────────────────────
//
// At each sample date T the engine is rebuilt with asOf=T, so only pivots CONFIRMED by T exist and
// touch history stops at T. The zones that come out are the zones a trader could actually have seen
// that day. Outcomes are then measured on bars strictly AFTER T. Any shortcut here — reusing today's
// levels, letting a pivot confirm early — produces a harness that proves whatever it was built to.
//
// ── WHAT IS MEASURED ────────────────────────────────────────────────────────
//
// Purely descriptive, per timeframe class (daily / weekly / monthly / multi-timeframe):
//   reached       price came into the zone at all within the horizon
//   held          price entered and closed back out on the correct side, without a decisive break
//   broke         price closed decisively through
//   barsToTouch   how long until first contact
//   barsToBreak   how long until it failed, when it did
//   MFE / MAE     max favourable / adverse excursion from first contact, in ATR units
//
// No p-values, no edge claims, no "levels work". Counts and medians, by class, with the sample size
// printed beside them so a thin cell is visibly thin.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs research/level-durability.mjs [TICKERS...]

import { loadDailyHistory, loadPriceQuality } from '../src/lib/structure/structure-data.js';
import { marketStructure } from '../src/lib/structure/engine.mjs';
import { atr } from '../src/lib/structure/bars.mjs';

const TICKERS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['MSFT', 'AAPL', 'NVDA', 'AMD', 'ALK', 'KO', 'JPM', 'XOM', 'WMT', 'PFE'];

/** Sessions after the sample date over which an outcome is measured. */
const HORIZON = 40;
/** Sample every N sessions. Dense enough for a sample, sparse enough to avoid overlapping windows. */
const STRIDE = 25;
/** A close this far through the zone counts as a decisive break rather than a wick. */
const BREAK_ATR = 0.5;

const median = (xs) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  const v = a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  return Math.round(v * 100) / 100;
};
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

/** Which class a zone belongs to for reporting. Multi-timeframe is its own class, not "weekly". */
function zoneClass(zone) {
  if (zone.timeframes.length >= 2) return 'multi-timeframe';
  return zone.timeframes[0];
}

/**
 * What happened to one zone over the horizon after the sample date.
 *
 * Measured on FUTURE bars only. `forward` starts the session after T.
 */
function outcome(zone, forward, unit) {
  if (!forward.length || !unit) return null;
  const isSupport = zone.side === 'support';
  const breakLevel = isSupport ? zone.low - unit * BREAK_ATR : zone.high + unit * BREAK_ATR;

  let touchIdx = null, breakIdx = null;
  for (let i = 0; i < forward.length; i++) {
    const b = forward[i];
    const reached = isSupport ? b.low <= zone.high : b.high >= zone.low;
    if (reached && touchIdx == null) touchIdx = i;
    const broke = isSupport ? b.close < breakLevel : b.close > breakLevel;
    if (broke) { breakIdx = i; break; }
  }
  if (touchIdx == null) return { reached: false };

  // Excursions are measured FROM FIRST CONTACT, which is the only moment the level was actually in
  // play. Measuring from the sample date would mix in the approach.
  const after = forward.slice(touchIdx);
  const ref = isSupport ? zone.low : zone.high;
  let mfe = 0, mae = 0;
  for (const b of after) {
    const fav = isSupport ? b.high - ref : ref - b.low;
    const adv = isSupport ? ref - b.low : b.high - ref;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
  }
  const held = breakIdx == null
    || after.some((b, i) => i < (breakIdx - touchIdx)
      && (isSupport ? b.close > zone.high : b.close < zone.low));

  return {
    reached: true,
    held: breakIdx == null,
    reclaimedBeforeBreak: held && breakIdx != null,
    broke: breakIdx != null,
    barsToTouch: touchIdx,
    barsToBreak: breakIdx == null ? null : breakIdx,
    mfeAtr: Math.round((mfe / unit) * 100) / 100,
    maeAtr: Math.round((mae / unit) * 100) / 100,
  };
}

const stats = new Map();   // `${class}|${side}` -> accumulator
const bump = (key) => {
  if (!stats.has(key)) {
    stats.set(key, {
      zones: 0, reached: 0, held: 0, broke: 0,
      barsToTouch: [], barsToBreak: [], mfe: [], mae: [], widthPct: [],
    });
  }
  return stats.get(key);
};

let tickersUsed = 0, samples = 0, skipped = 0;

for (const ticker of TICKERS) {
  const [bars, quality] = await Promise.all([loadDailyHistory(ticker), loadPriceQuality(ticker)]);
  if (bars.length < 600) { skipped++; continue; }
  if (quality?.usable === false) { skipped++; continue; }
  tickersUsed++;

  // Leave HORIZON bars at the end so every sample has a full forward window — a truncated window
  // would silently bias toward "held".
  for (let i = 500; i < bars.length - HORIZON; i += STRIDE) {
    const asOf = bars[i].date;
    // A break inside the measurement window makes the comparison span two securities.
    if (quality?.lastBreak && quality.lastBreak > asOf
      && quality.lastBreak <= bars[Math.min(i + HORIZON, bars.length - 1)].date) continue;

    const s = marketStructure(bars.slice(0, i + 1), { asOf, priceQuality: quality });
    if (!s.available) continue;
    const forward = bars.slice(i + 1, i + 1 + HORIZON);
    const unit = atr(bars.slice(Math.max(0, i - 30), i + 1), 14);
    if (!unit) continue;
    samples++;

    const zones = [
      ...(s.multiTimeframe.support.all || []),
      ...(s.multiTimeframe.resistance.all || []),
    ];
    for (const z of zones) {
      // Only zones within reach are informative: one 40% away will never be touched in 40 sessions
      // and would pad every "held" figure with zones that were never tested.
      if (z.distancePct > 12) continue;
      const o = outcome(z, forward, unit);
      if (!o) continue;
      const acc = bump(`${zoneClass(z)}|${z.side}`);
      acc.zones++;
      acc.widthPct.push(z.widthPct);
      if (!o.reached) continue;
      acc.reached++;
      if (o.held) acc.held++; else acc.broke++;
      acc.barsToTouch.push(o.barsToTouch);
      if (o.barsToBreak != null) acc.barsToBreak.push(o.barsToBreak);
      acc.mfe.push(o.mfeAtr);
      acc.mae.push(o.maeAtr);
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const L = (s = '') => console.log(s);
L();
L('='.repeat(104));
L(`LEVEL DURABILITY BY TIMEFRAME — ${tickersUsed} tickers, ${samples} point-in-time samples, `
  + `${HORIZON}-session horizon, stride ${STRIDE}`);
L(`${skipped} tickers skipped (insufficient history or unusable price series)`);
L('='.repeat(104));
L();
L(`${'class'.padEnd(18)} ${'side'.padEnd(11)} ${'zones'.padStart(6)} ${'reached'.padStart(8)} ${'reach%'.padStart(7)}`
  + ` ${'held%'.padStart(6)} ${'broke%'.padStart(7)} ${'med bars'.padStart(9)} ${'med MFE'.padStart(8)} ${'med MAE'.padStart(8)} ${'med width%'.padStart(11)}`);
L('-'.repeat(104));

const order = ['daily', 'weekly', 'monthly', 'multi-timeframe'];
for (const side of ['support', 'resistance']) {
  for (const cls of order) {
    const a = stats.get(`${cls}|${side}`);
    if (!a || !a.zones) continue;
    L(`${cls.padEnd(18)} ${side.padEnd(11)} ${String(a.zones).padStart(6)} ${String(a.reached).padStart(8)}`
      + ` ${String(pct(a.reached, a.zones) ?? '—').padStart(7)}`
      + ` ${String(pct(a.held, a.reached) ?? '—').padStart(6)}`
      + ` ${String(pct(a.broke, a.reached) ?? '—').padStart(7)}`
      + ` ${String(median(a.barsToTouch) ?? '—').padStart(9)}`
      + ` ${String(median(a.mfe) ?? '—').padStart(8)}`
      + ` ${String(median(a.mae) ?? '—').padStart(8)}`
      + ` ${String(median(a.widthPct) ?? '—').padStart(11)}`);
  }
  L();
}

L('-'.repeat(104));
L('held% = of the zones price actually REACHED, the share that were not decisively closed through');
L('MFE/MAE are in ATR units, measured from first contact. Descriptive only — no edge is claimed,');
L('and a thin cell is a thin cell: read the zones column before reading the percentage beside it.');
L('='.repeat(104));
