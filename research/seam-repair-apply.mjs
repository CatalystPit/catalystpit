// STEP B — REPAIR THE 16 CONFIRMED SEAM TICKERS.
//
// Converts the TIINGO-sourced rows on those tickers from TOTAL RETURN to SPLIT-ADJUSTED, so each
// series carries one convention end to end and matches the Polygon rows already beside it. Polygon
// rows are not touched: they are already on the canonical basis.
//
// ── THE GATE ────────────────────────────────────────────────────────────────
//
// Nothing is written until the derivation proves itself against an INDEPENDENT source. Tiingo raw
// OHLCV plus splitFactor gives a split-adjusted series; on every date where a Polygon row already
// exists, the two are the same quantity computed by different vendors from different inputs. If
// they agree, the derivation is right. If they do not, the repair aborts for that ticker rather
// than replacing one wrong convention with another.
//
// --apply is required. Without it this is a dry run that reports what would change.
//
// Run: node --env-file=.env.local research/seam-repair-apply.mjs [--apply]

import { neon } from '@neondatabase/serverless';
import { splitAdjustSeries } from '../src/lib/price-semantics.mjs';
import { CONFIRMED } from './seam-confirmed.mjs';

const sql = neon(process.env.DATABASE_URL);
const KEY = process.env.TIINGO_API_KEY;
const H = { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` };
const L = (s = '') => console.log(s);
const APPLY = process.argv.includes('--apply');

// How closely the derived series must match Polygon's on shared dates. Vendors differ in the last
// cent on old bars; a tenth of a percent is far tighter than any seam and far looser than rounding.
const AGREE_TOL = 0.001;
const MIN_AGREE_RATE = 0.97;

L(APPLY ? 'MODE: APPLY (rows will be written)' : 'MODE: DRY RUN (no writes)');
L(`tickers: ${CONFIRMED.join(', ')}\n`);

async function tiingoRaw(sym) {
  const u = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(sym)}/prices?startDate=1960-01-01&endDate=${new Date().toISOString().slice(0, 10)}`;
  for (let a = 1; a <= 4; a++) {
    const r = await fetch(u, { headers: H });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 5000 * a)); continue; }
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const j = await r.json();
    return { ok: true, rows: Array.isArray(j) ? j : [] };
  }
  return { ok: false, reason: 'rate limited after retries' };
}

const results = [];
for (const ticker of CONFIRMED) {
  const res = await tiingoRaw(ticker);
  if (!res.ok) { results.push({ ticker, status: 'FETCH FAILED', detail: res.reason }); continue; }

  const raw = res.rows.map((r) => ({
    date: String(r.date).slice(0, 10),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
    volume: Number(r.volume) || 0,
    splitFactor: Number(r.splitFactor) || 1,
  })).filter((b) => [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!raw.length) { results.push({ ticker, status: 'NO VENDOR DATA' }); continue; }

  // Derive over the FULL history so the split accumulation is complete, then use only what we need.
  const adj = splitAdjustSeries(raw);
  const byDate = new Map(adj.map((b) => [b.date, b]));

  // ── the independent check ──
  const poly = await sql.query(
    `select date::text d, open, high, low, close, volume from ticker_daily_candles
      where ticker=$1 and source='polygon' order by date`, [ticker]);
  let compared = 0, agreed = 0, worst = 0;
  for (const p of poly) {
    const d = byDate.get(p.d);
    if (!d) continue;
    compared++;
    const diff = Math.abs(d.close - Number(p.close)) / Number(p.close);
    if (diff > worst) worst = diff;
    if (diff <= AGREE_TOL) agreed++;
  }
  const rate = compared ? agreed / compared : 0;

  const targets = await sql.query(
    `select date::text d from ticker_daily_candles where ticker=$1 and source='tiingo'`, [ticker]);
  const writable = targets.filter((t) => byDate.has(t.d));

  const rec = {
    ticker, status: 'ok', compared, agreeRate: Math.round(rate * 1000) / 10,
    worstDiffPct: Math.round(worst * 10000) / 100,
    tiingoRows: targets.length, covered: writable.length,
  };

  if (compared < 20) { rec.status = 'SKIP — too few shared dates to verify'; results.push(rec); continue; }
  if (rate < MIN_AGREE_RATE) { rec.status = 'ABORT — derivation disagrees with Polygon'; results.push(rec); continue; }
  if (writable.length < targets.length) {
    rec.note = `${targets.length - writable.length} rows have no vendor bar and are LEFT UNCHANGED`;
  }

  if (APPLY) {
    let written = 0;
    for (let i = 0; i < writable.length; i += 500) {
      const chunk = writable.slice(i, i + 500);
      const params = [ticker];
      const values = chunk.map((t) => {
        const b = byDate.get(t.d);
        const base = params.length;
        params.push(b.date, b.open, b.high, b.low, b.close, b.volume);
        return `($${base + 1}::date,$${base + 2}::float8,$${base + 3}::float8,$${base + 4}::float8,$${base + 5}::float8,$${base + 6}::float8)`;
      }).join(',');
      const out = await sql.query(`
        update ticker_daily_candles c
           set open=v.o, high=v.h, low=v.l, close=v.c, volume=v.vol,
               source='tiingo_split_adj'
          from (values ${values}) as v(d,o,h,l,c,vol)
         where c.ticker=$1 and c.date=v.d and c.source='tiingo'
        returning 1`, params);
      written += out.length;
    }
    rec.written = written;
  }
  results.push(rec);
}

L(`${'ticker'.padEnd(8)} ${'status'.padEnd(42)} ${'cmp'.padStart(5)} ${'agree%'.padStart(7)} ${'worst%'.padStart(7)} ${'rows'.padStart(6)} ${'written'.padStart(8)}`);
for (const r of results) {
  L(`${r.ticker.padEnd(8)} ${String(r.status).padEnd(42)} ${String(r.compared ?? '').padStart(5)}`
    + ` ${String(r.agreeRate ?? '').padStart(7)} ${String(r.worstDiffPct ?? '').padStart(7)}`
    + ` ${String(r.tiingoRows ?? '').padStart(6)} ${String(r.written ?? '-').padStart(8)}`);
  if (r.note) L(`${''.padEnd(9)} ${r.note}`);
  if (r.detail) L(`${''.padEnd(9)} ${r.detail}`);
}
const okc = results.filter((r) => r.status === 'ok').length;
L(`\n${okc}/${CONFIRMED.length} tickers verified against Polygon`
  + (APPLY ? `; ${results.reduce((s, r) => s + (r.written || 0), 0).toLocaleString()} rows written` : '; DRY RUN — nothing written'));
