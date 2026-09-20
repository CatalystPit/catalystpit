// STEP E — REVALIDATE MARKET STRUCTURE AGAINST THE REPAIRED PRICES.
//
// Market Structure is derived entirely from OHLC, so the repair can move every part of it: swing
// pivots, the trend label each timeframe carries, moving averages, support/resistance zones, how
// many times a zone was touched, whether it earns MAJOR, and whether a structural disruption is
// reported. This recomputes all of it on the pre- and post-repair series and reports what moved.
//
// Unlike reaction, structure uses HIGH and LOW as well as CLOSE, so "before" substitutes all four
// fields from the snapshot rather than close alone. Substituting only close would compare a real
// series against one that never existed.
//
// MSFT IS CALLED OUT SEPARATELY. Its monthly label is what started this line of work, so its
// before/after is printed in full rather than counted. That is reporting, not tuning — nothing here
// changes a threshold, and per the standing instruction MSFT is not patched.
//
// Run: node --env-file=.env.local research/revalidate-structure.mjs

import { neon } from '@neondatabase/serverless';
import { marketStructure } from '../src/lib/structure/engine.mjs';
import fs2 from 'node:fs';

// Same as the reaction rerun: revalidate what THIS repair touched, read from the audit.
const audit = JSON.parse(fs2.readFileSync('research/convention-audit.json', 'utf8'));
const CONFIRMED = Object.entries(audit)
  .filter(([, v]) => v.action === 'REPAIR' || v.action === 'RELABEL_ONLY')
  .map(([t]) => t);

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);
const RUN = (await sql.query(
  'select run_id from ticker_daily_candles_backup order by backed_up_at desc limit 1'))[0].run_id;

const n1 = (v) => (Number.isFinite(v) ? Number(v).toFixed(2) : '-');

async function series(ticker) {
  const live = await sql.query(
    `select date::text date, open, high, low, close, volume
       from ticker_daily_candles where ticker=$1 order by date`, [ticker]);
  const back = await sql.query(
    `select date::text date, open, high, low, close
       from ticker_daily_candles_backup where run_id=$1 and ticker=$2`, [RUN, ticker]);
  const bm = new Map(back.map((b) => [b.date, b]));
  const num = (b) => ({
    date: b.date, open: Number(b.open), high: Number(b.high), low: Number(b.low),
    close: Number(b.close), volume: Number(b.volume) || 0,
  });
  const after = live.map(num);
  const before = live.map((b) => {
    const o = bm.get(b.date);
    return o ? { ...num(b), open: Number(o.open), high: Number(o.high), low: Number(o.low), close: Number(o.close) }
      : num(b);
  });
  return { before, after };
}

// support/resistance are objects: { nearest, all, confluence, relationship, ... }.
const zlist = (side) => (Array.isArray(side?.all) ? side.all : []);
const zoneSig = (side) => zlist(side).map((x) => `${n1(x.low)}-${n1(x.high)}`).join('|');
const majorCount = (side) => zlist(side).filter((x) => x.major).length;
const touchTotal = (side) => zlist(side).reduce((s, x) => s + (Number(x.touches) || 0), 0);
const confCount = (side) => (Array.isArray(side?.confluence) ? side.confluence.length : 0);
const relState = (side) => side?.relationship?.state ?? '-';
const nearestSig = (side) => (side?.nearest ? `${n1(side.nearest.low)}-${n1(side.nearest.high)}` : '-');

L(`${'ticker'.padEnd(7)} ${'D trend'.padEnd(18)} ${'W trend'.padEnd(18)} ${'M trend'.padEnd(18)} ${'align'.padEnd(12)} zones S/R  MAJOR`);
L(`${''.padEnd(7)} ${'before -> after'.padEnd(18)}`);

const changes = { trend: 0, alignment: 0, zones: 0, major: 0, touches: 0, ma: 0, disruption: 0,
  confluence: 0, relationship: 0, nearest: 0, pivots: 0, pivotCount: 0 };
let tickers = 0;
let swingsSeen = 0;
const detail = [];

for (const ticker of CONFIRMED) {
  const { before, after } = await series(ticker);
  const a = marketStructure(after);
  const b = marketStructure(before);
  if (!a.available || !b.available) { L(`${ticker.padEnd(7)} unavailable (${a.reason || b.reason})`); continue; }
  tickers++;

  const tf = ['daily', 'weekly', 'monthly'];
  const cells = tf.map((k) => {
    const bt = b[k]?.trend?.state ?? b[k]?.trend ?? '-';
    const at = a[k]?.trend?.state ?? a[k]?.trend ?? '-';
    if (String(bt) !== String(at)) changes.trend++;
    return String(bt) === String(at) ? String(at).padEnd(18) : `${bt}->${at}`.padEnd(18);
  });

  const balign = b.multiTimeframe?.alignment?.state ?? '-';
  const aalign = a.multiTimeframe?.alignment?.state ?? '-';
  if (String(balign) !== String(aalign)) changes.alignment++;

  const zsB = zoneSig(b.multiTimeframe?.support) + '//' + zoneSig(b.multiTimeframe?.resistance);
  const zsA = zoneSig(a.multiTimeframe?.support) + '//' + zoneSig(a.multiTimeframe?.resistance);
  if (zsB !== zsA) changes.zones++;

  const mjB = majorCount(b.multiTimeframe?.support) + majorCount(b.multiTimeframe?.resistance);
  const mjA = majorCount(a.multiTimeframe?.support) + majorCount(a.multiTimeframe?.resistance);
  if (mjB !== mjA) changes.major++;

  const tcB = touchTotal(b.multiTimeframe?.support) + touchTotal(b.multiTimeframe?.resistance);
  const tcA = touchTotal(a.multiTimeframe?.support) + touchTotal(a.multiTimeframe?.resistance);
  if (tcB !== tcA) changes.touches++;

  const cfB = confCount(b.multiTimeframe?.support) + confCount(b.multiTimeframe?.resistance);
  const cfA = confCount(a.multiTimeframe?.support) + confCount(a.multiTimeframe?.resistance);
  if (cfB !== cfA) changes.confluence++;

  const rsB = `${relState(b.multiTimeframe?.support)}/${relState(b.multiTimeframe?.resistance)}`;
  const rsA = `${relState(a.multiTimeframe?.support)}/${relState(a.multiTimeframe?.resistance)}`;
  if (rsB !== rsA) changes.relationship++;

  const nrB = `${nearestSig(b.multiTimeframe?.support)}/${nearestSig(b.multiTimeframe?.resistance)}`;
  const nrA = `${nearestSig(a.multiTimeframe?.support)}/${nearestSig(a.multiTimeframe?.resistance)}`;
  if (nrB !== nrA) changes.nearest++;

  for (const k of tf) {
    const bd = JSON.stringify(b[k]?.movingAverages ?? null);
    const ad = JSON.stringify(a[k]?.movingAverages ?? null);
    if (bd !== ad) { changes.ma++; break; }
  }
  // swings is { count, lastHigh, prevHigh, lastLow, prevLow } — NOT an array. Reading .length off it
  // yielded undefined on both sides, so the comparison could never fail: a check that passes because
  // it compares nothing to nothing. Compare the pivots themselves.
  for (const k of tf) {
    const bs = b[k]?.swings, as = a[k]?.swings;
    swingsSeen += Number(as?.count) || 0;
    if (JSON.stringify(bs ?? null) !== JSON.stringify(as ?? null)) { changes.pivots++; break; }
  }
  for (const k of tf) {
    if ((Number(b[k]?.swings?.count) || 0) !== (Number(a[k]?.swings?.count) || 0)) { changes.pivotCount++; break; }
  }
  const dB = JSON.stringify(b.daily?.disruption ?? b.daily?.structuralDisruption ?? null);
  const dA = JSON.stringify(a.daily?.disruption ?? a.daily?.structuralDisruption ?? null);
  if (dB !== dA) changes.disruption++;

  L(`${ticker.padEnd(7)} ${cells.join(' ')} ${(balign === aalign ? aalign : `${balign}->${aalign}`).padEnd(12)}`
    + ` ${String(zlist(a.multiTimeframe?.support).length)}/${String(zlist(a.multiTimeframe?.resistance).length)}`
    + `        ${mjB === mjA ? mjA : `${mjB}->${mjA}`}`);

  detail.push({ ticker, b, a, zsB, zsA, tcB, tcA });
}

L(`\n=== WHAT MOVED (of ${tickers} tickers) ===`);
L(`  timeframe trend labels changed : ${changes.trend}`);
L(`  multi-timeframe alignment      : ${changes.alignment}`);
L(`  zone boundaries                : ${changes.zones}`);
L(`  MAJOR classification counts    : ${changes.major}`);
L(`  zone touch counts              : ${changes.touches}`);
L(`  moving averages                : ${changes.ma}`);
L(`  structural disruption          : ${changes.disruption}`);
L(`  swing pivots (full comparison) : ${changes.pivots}`
  + `   (${swingsSeen} pivots compared — a zero here would mean the check was vacuous)`);
L(`  swing pivot COUNT per timeframe: ${changes.pivotCount}`);
L(`  confluence zone counts         : ${changes.confluence}`);
L(`  nearest zone                   : ${changes.nearest}`);
L(`  price-vs-zone relationship     : ${changes.relationship}`);

// ── MSFT in full ─────────────────────────────────────────────────────────────
const m = detail.find((d) => d.ticker === 'MSFT');
if (m) {
  L('\n=== MSFT IN FULL (the diagnostic case; reported, not tuned) ===');
  for (const k of ['daily', 'weekly', 'monthly']) {
    const bt = m.b[k]?.trend, at = m.a[k]?.trend;
    L(`  ${k.padEnd(8)} before ${String(bt?.state ?? bt).padEnd(12)} after ${String(at?.state ?? at).padEnd(12)}`
      + `  trendAsOfPivot before ${m.b[k]?.trendAsOfPivot ?? '-'} after ${m.a[k]?.trendAsOfPivot ?? '-'}`
      + `  barsSincePivot ${m.b[k]?.barsSincePivot ?? '-'} -> ${m.a[k]?.barsSincePivot ?? '-'}`);
    const bma = m.b[k]?.movingAverages, ama = m.a[k]?.movingAverages;
    if (bma || ama) {
      const am = new Map((ama || []).map((x) => [x.label, x.value]));
      L(`           MAs  ${(bma || []).map((x) => `${x.label} ${n1(x.value)} -> ${n1(am.get(x.label))}`).join('   ')}`);
    }
  }
  L(`  price      before ${n1(m.b.currentPrice)}  after ${n1(m.a.currentPrice)}`);
  L(`  zoneUnit   before ${n1(m.b.zoneUnit)}  after ${n1(m.a.zoneUnit)}   dailyAtr ${n1(m.b.dailyAtr)} -> ${n1(m.a.dailyAtr)}`);
  L(`  touches    before ${m.tcB}  after ${m.tcA}`);
  L(`  support    before ${zoneSig(m.b.multiTimeframe?.support) || '-'}`);
  L(`             after  ${zoneSig(m.a.multiTimeframe?.support) || '-'}`);
  L(`  resistance before ${zoneSig(m.b.multiTimeframe?.resistance) || '-'}`);
  L(`             after  ${zoneSig(m.a.multiTimeframe?.resistance) || '-'}`);
}
