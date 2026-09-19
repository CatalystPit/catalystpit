// PHASE 1 (definitive) — is each source transition an ACTUAL convention mismatch?
//
// The statistical version of this audit used "a move larger than the ticker normally makes", and
// that hid real defects: MSFT's proven 3.7% seam is only 3.4x its median daily move and fell under
// the threshold. A fabricated 3.7% gap is a fabricated gap regardless of how volatile the stock is.
//
// So this asks the vendor instead of inferring. For every source transition, Tiingo is queried for
// the same dates and the stored close is compared against BOTH of Tiingo's series:
//
//   stored == adjClose  -> the row is on the total-return convention
//   stored == close     -> the row is split-adjusted only (Polygon's convention)
//
// A transition is a real seam when the two sides answer differently AND the two conventions
// actually differ at that date. Everything else is a handoff where the conventions happened to
// agree, which is harmless.
//
// Run: node --env-file=.env.local research/price-seam-definitive.mjs

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const KEY = process.env.TIINGO_API_KEY;
const H = { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` };
const L = (s = '') => console.log(s);
const near = (a, b) => a != null && b != null && Math.abs(a - b) / b < 0.002;

async function tiingoRange(sym, from, to) {
  const u = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(sym)}/prices?startDate=${from}&endDate=${to}`;
  const r = await fetch(u, { headers: H });
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j) ? new Map(j.map((x) => [String(x.date).slice(0, 10), x])) : null;
}

const transitions = await sql.query(`
  with s as (
    select ticker, date, close, source,
           lag(source) over (partition by ticker order by date) prev_src,
           lag(close)  over (partition by ticker order by date) prev_close,
           lag(date)   over (partition by ticker order by date) prev_date
      from ticker_daily_candles)
  select ticker, date::text d, prev_date::text pd, prev_src, source, prev_close, close
    from s where prev_src is not null and source is distinct from prev_src
   order by ticker, date`);

L(`source transitions to verify: ${transitions.length}`);

const byTicker = new Map();
for (const t of transitions) {
  if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
  byTicker.get(t.ticker).push(t);
}

const seams = [];
const clean = [];
let unverifiable = 0;
let n = 0;

for (const [ticker, list] of byTicker) {
  n++;
  const from = list[0].pd, to = list[list.length - 1].d;
  const tii = await tiingoRange(ticker, from, to);
  if (!tii) { unverifiable += list.length; continue; }

  for (const t of list) {
    const a = tii.get(t.pd), b = tii.get(t.d);
    if (!a || !b) { unverifiable++; continue; }
    const aAdj = Number(a.adjClose), aRaw = Number(a.close);
    const bAdj = Number(b.adjClose), bRaw = Number(b.close);
    // Which convention is each stored row on?
    const beforeConv = near(Number(t.prev_close), aAdj) ? 'total-return'
      : near(Number(t.prev_close), aRaw) ? 'split-only' : 'unknown';
    const afterConv = near(Number(t.close), bAdj) ? 'total-return'
      : near(Number(t.close), bRaw) ? 'split-only' : 'unknown';
    // How far apart ARE the two conventions at the later date? If they coincide, a handoff between
    // them changes nothing.
    const spread = bRaw > 0 ? ((bRaw - bAdj) / bAdj) * 100 : 0;
    const rec = {
      ticker, boundary: `${t.pd} -> ${t.d}`, date: t.d,
      from: t.prev_src, to: t.source, beforeConv, afterConv,
      spreadPct: Math.round(spread * 100) / 100,
      storedGapPct: Math.round(((Number(t.close) - Number(t.prev_close)) / Number(t.prev_close)) * 10000) / 100,
    };
    if (beforeConv !== afterConv && beforeConv !== 'unknown' && afterConv !== 'unknown'
      && Math.abs(spread) >= 0.05) seams.push(rec);
    else clean.push(rec);
  }
  if (n % 25 === 0) L(`  …verified ${n}/${byTicker.size} tickers`);
}

L('');
L('='.repeat(96));
L(`DEFINITIVE RESULT — ${seams.length} real convention seams, ${clean.length} harmless handoffs, ${unverifiable} unverifiable`);
L('='.repeat(96));
const seamTickers = [...new Set(seams.map((s) => s.ticker))];
L(`tickers with a REAL seam: ${seamTickers.length}`);
L('');
L(`${'ticker'.padEnd(8)} ${'boundary'.padEnd(26)} ${'before'.padEnd(13)} ${'after'.padEnd(13)} ${'conv spread'.padStart(11)} ${'stored gap'.padStart(11)}`);
for (const s of seams.sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct))) {
  L(`${s.ticker.padEnd(8)} ${s.boundary.padEnd(26)} ${s.beforeConv.padEnd(13)} ${s.afterConv.padEnd(13)}`
    + ` ${String(s.spreadPct + '%').padStart(11)} ${String(s.storedGapPct + '%').padStart(11)}`);
}

L('');
L('conventions observed across ALL verified rows:');
const conv = {};
for (const r of [...seams, ...clean]) {
  conv[`${r.from}:${r.beforeConv}`] = (conv[`${r.from}:${r.beforeConv}`] || 0) + 1;
  conv[`${r.to}:${r.afterConv}`] = (conv[`${r.to}:${r.afterConv}`] || 0) + 1;
}
for (const [k, v] of Object.entries(conv).sort((a, b) => b[1] - a[1])) L(`  ${k.padEnd(28)} ${v}`);
