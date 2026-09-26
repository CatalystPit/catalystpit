// FEAR & GREED V2 — the pre-deployment report, read-only by default.
//
//   node --env-file=.env.local --experimental-loader file:///.../ext-resolve-loader.mjs \
//     scripts/fear-greed-v2-report.mjs [--write]
//
// Computes the V2 index from production data and prints what the new component is doing, what it
// does to the composite, and the two proofs that matter: that no historical value can see the
// future, and that every session ranks against a window ending at itself.
//
// ⚠️ NOTHING IS WRITTEN WITHOUT --write. The report runs against the live database because that is
// the only place the real series exist; it takes nothing but SELECTs unless asked.

import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db.js';
import {
  loadPanelSeries, loadCloses, MARKET_SYMBOL, CREDIT_RISK_SYMBOL, CREDIT_SAFE_SYMBOL,
  VOL_MARKET_SYMBOL, VOL_MARKET_WARMUP_DAYS,
} from '../src/lib/fear-greed/data.mjs';
import { rawSeries, indexForDate, indexHistory, buildPayload } from '../src/lib/fear-greed/compute.mjs';
import { VOL_MARKET_MA } from '../src/lib/fear-greed/series.mjs';
import { METHODOLOGY, COMPONENTS, NORM_WINDOW, MIN_COMPONENTS, zoneFor } from '../src/lib/fear-greed/model.mjs';
import { saveHistory, savePayload } from '../src/lib/fear-greed/store.mjs';

const WRITE = process.argv.includes('--write');
const L = (s = '') => console.log(s);
const n2 = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

const t0 = Date.now();
L(`[fg-v2] methodology version ${METHODOLOGY.version} · ${COMPONENTS.length} components · floor ${MIN_COMPONENTS}`);

const [panel, spy, volMarket, risk, safe] = await Promise.all([
  loadPanelSeries(db, sql, {}),
  loadCloses(db, sql, MARKET_SYMBOL, {}),
  loadCloses(db, sql, VOL_MARKET_SYMBOL, { sinceDays: VOL_MARKET_WARMUP_DAYS }),
  loadCloses(db, sql, CREDIT_RISK_SYMBOL, {}),
  loadCloses(db, sql, CREDIT_SAFE_SYMBOL, {}),
]);
L(`[fg-v2] loaded: panel ${panel.length} · SPY ${spy.length} · volatility market ${volMarket.length}`
  + ` (${volMarket[0]?.date} → ${volMarket.at(-1)?.date}) · HYG ${risk.length} · IEF ${safe.length}`);

const series = rawSeries({ panel, spy, volMarket, credit: { risk, safe } });
const history = indexHistory(series);
const payload = buildPayload(series);
const current = history.at(-1);

// ── 1-5. THE NEW COMPONENT, TODAY ────────────────────────────────────────────
const closeAt = new Map(volMarket.map((b) => [b.date, b.close]));
const asOf = current.date;
const idx = volMarket.findIndex((b) => b.date === asOf);
const smaWindow = idx >= VOL_MARKET_MA - 1 ? volMarket.slice(idx - VOL_MARKET_MA + 1, idx + 1) : [];
const sma = smaWindow.length === VOL_MARKET_MA
  ? smaWindow.reduce((a, b) => a + b.close, 0) / VOL_MARKET_MA : null;
const mv = current.components.marketvol;

L('');
L('── THE SIXTH COMPONENT, AS OF ' + asOf + ' ──');
L(`  1. volatility-market close .............. ${n2(closeAt.get(asOf))}`);
L(`  2. ${VOL_MARKET_MA}-session simple moving average ...... ${n2(sma, 4)}`);
L(`  3. raw distance from the average ........ ${mv ? (mv.raw * 100).toFixed(2) + '%' : '—'}`
  + `   (independent check: ${sma ? (((closeAt.get(asOf) / sma) - 1) * 100).toFixed(2) + '%' : '—'})`);
L(`  4. normalised Market Volatility score ... ${mv ? mv.score : '—'}`
  + `   (percentile in its own ${mv?.samples ?? 0}-session window, inverted)`);
L(`  5. classification ....................... ${mv ? zoneFor(mv.score).label : 'UNAVAILABLE'}`);

// ── 6-7. V1 VERSUS V2 ────────────────────────────────────────────────────────
const v1 = await db.execute(sql`
  select date::text as date, score::float8 as score, zone, component_count
    from fear_greed_daily where version = 'fear_greed_v1' order by date`);
const v1rows = (v1?.rows ?? v1 ?? []).map((r) => ({ ...r, date: String(r.date) }));
const v1by = new Map(v1rows.map((r) => [r.date, r]));
const v1now = v1by.get(asOf) || null;

L('');
L('── THE COMPOSITE ──');
L(`  6. V1 score on ${asOf} ............... ${v1now ? `${v1now.score} (${v1now.zone}, ${v1now.component_count} components)` : '—'}`);
L(`  7. V2 score on ${asOf} ............... ${current.score} (${current.zone.label}, ${current.componentCount} components)`);
L(`     components: ${Object.entries(current.components)
  .map(([k, c]) => `${k} ${c ? c.score : '—'}`).join(' · ')}`);

// ── 8. HISTORY ───────────────────────────────────────────────────────────────
const withMv = history.filter((h) => h.components.marketvol);
const counts = history.reduce((m, h) => { m[h.componentCount] = (m[h.componentCount] || 0) + 1; return m; }, {});
L('');
L('── HISTORY ──');
L(`  8. V2 sessions computed ................. ${history.length}  (${history[0].date} → ${history.at(-1).date})`);
L(`     V1 sessions stored ................... ${v1rows.length}  (${v1rows[0]?.date} → ${v1rows.at(-1)?.date})`);
L(`     sessions carrying Market Volatility .. ${withMv.length} / ${history.length}`
  + (withMv.length === history.length ? '  (every one)' : `  — first ${withMv[0]?.date}`));
L(`     component-count distribution ......... ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' · ')}`);

// Coverage of the volatility market against the reporting calendar.
const firstCalendar = history[0].date;
const rawMv = series.marketvol;
L(`     volatility-market raw series ......... ${rawMv.length} sessions, first ${rawMv[0]?.date}`);
L(`     first session it could be SCORED ..... ${rawMv.length > NORM_WINDOW - 1 ? rawMv[NORM_WINDOW - 1].date : 'never'}`
  + `   (needs ${VOL_MARKET_MA} + ${NORM_WINDOW} sessions)`);
L(`     reporting calendar starts ............ ${firstCalendar}`);

// Distribution of the delta, so the size of the change is visible rather than asserted.
const deltas = history.filter((h) => v1by.has(h.date)).map((h) => h.score - v1by.get(h.date).score);
if (deltas.length) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  L(`     V2 − V1 over ${deltas.length} shared sessions: min ${n2(sorted[0])} · p25 ${n2(q(0.25))}`
    + ` · median ${n2(q(0.5))} · p75 ${n2(q(0.75))} · max ${n2(sorted.at(-1))}`);
  const zoneChanged = history.filter((h) => v1by.has(h.date) && h.zone.label !== v1by.get(h.date).zone).length;
  L(`     sessions whose ZONE changed .......... ${zoneChanged} / ${deltas.length}`);
}

// ── 9-10. POINT-IN-TIME PROOF ────────────────────────────────────────────────
//
// ⚠️ NOT AN ASSERTION ABOUT THE CODE — A RECOMPUTATION. Each sampled session is scored twice: once
// from the full series, once from a series with every later observation deleted. If anything read
// forward — a moving average centred by mistake, a percentile ranked against the whole history —
// the two would differ. Sampling is spread across the whole span, including the first and last.
L('');
L('── POINT-IN-TIME ──');
const truncate = (s, d) => Object.fromEntries(Object.entries(s)
  .map(([k, v]) => [k, v.filter((p) => String(p.date) <= d)]));
const picks = [...new Set([0, 1, Math.floor(history.length * 0.25), Math.floor(history.length * 0.5),
  Math.floor(history.length * 0.75), history.length - 2, history.length - 1]
  .filter((i) => i >= 0 && i < history.length))];
let same = 0, differ = [];
for (const i of picks) {
  const d = history[i].date;
  const a = indexForDate(series, d);
  const b = indexForDate(truncate(series, d), d);
  const aMv = a.components.marketvol, bMv = b.components.marketvol;
  const ok = a.score === b.score
    && (aMv?.score ?? null) === (bMv?.score ?? null)
    && (aMv?.raw ?? null) === (bMv?.raw ?? null);
  if (ok) same++; else differ.push(`${d}: ${a.score}/${b.score}`);
  L(`     ${d}  composite ${a.score} = ${b.score}  ·  marketvol ${aMv ? aMv.score : '—'} = ${bMv ? bMv.score : '—'}`
    + `  ·  raw ${aMv ? aMv.raw.toFixed(6) : '—'} = ${bMv ? bMv.raw.toFixed(6) : '—'}  ${ok ? 'OK' : 'MISMATCH'}`);
}
L(`  9. sampled sessions identical when the future is deleted: ${same}/${picks.length}`
  + (differ.length ? `  MISMATCHES: ${differ.join(', ')}` : ''));

// Every session's window must end at or before itself, and be exactly NORM_WINDOW long.
let windowOk = 0, windowBad = [];
const mvDates = rawMv.map((p) => String(p.date));
for (const h of withMv) {
  const i = mvDates.indexOf(h.date);
  const win = rawMv.slice(Math.max(0, i - NORM_WINDOW + 1), i + 1);
  const endsAtSelf = win.at(-1)?.date === h.date;
  const fullLength = win.length === NORM_WINDOW;
  const samplesMatch = h.components.marketvol.samples === NORM_WINDOW;
  if (endsAtSelf && fullLength && samplesMatch) windowOk++;
  else windowBad.push(h.date);
}
L(` 10. sessions whose normalisation window ends at themselves and is exactly ${NORM_WINDOW} long: `
  + `${windowOk}/${withMv.length}` + (windowBad.length ? `  BAD: ${windowBad.slice(0, 5).join(', ')}` : ''));
// And the moving average itself: recompute every session's raw value from bars at or before it.
let smaOk = 0, smaBad = [];
for (const p of rawMv) {
  const i = volMarket.findIndex((b) => b.date === p.date);
  const w = volMarket.slice(i - VOL_MARKET_MA + 1, i + 1);
  const expect = volMarket[i].close / (w.reduce((a, b) => a + b.close, 0) / VOL_MARKET_MA) - 1;
  if (Math.abs(expect - p.value) < 1e-12 && w.at(-1).date === p.date) smaOk++;
  else smaBad.push(p.date);
}
L(`     raw values recomputed from trailing bars only: ${smaOk}/${rawMv.length}`
  + (smaBad.length ? `  BAD: ${smaBad.slice(0, 5).join(', ')}` : ''));

L('');
L(`[fg-v2] payload available=${payload.available} score=${payload.score} zone=${payload.zone?.label}`
  + ` components=${payload.componentCount} in ${Date.now() - t0}ms`);

if (WRITE) {
  // ⚠️ V1 IS NOT TOUCHED. fear_greed_daily is keyed (date, version); these are new rows under
  // fear_greed_v2, and the V1 series stays exactly where it is.
  const saved = await saveHistory(history);
  const cached = await savePayload(payload);
  L(`[fg-v2] WROTE ${saved.written} rows (skipped ${saved.skipped}) · payload cached: ${cached}`);
  const after = await db.execute(sql`
    select version, count(*)::int as n, min(date)::text as mn, max(date)::text as mx
      from fear_greed_daily group by version order by version`);
  for (const r of (after?.rows ?? after ?? [])) L(`[fg-v2]   ${r.version}: ${r.n} rows ${r.mn} → ${r.mx}`);
} else {
  L('[fg-v2] read-only. Re-run with --write to store the V2 history.');
}
