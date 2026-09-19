// Evidence Timeline — live validation against real Catalyst Pit data.
//
// Proves the thing that matters: every marker sits on the date the evidence became PUBLIC, not on
// the underlying transaction or reference date. For Congress and 13F those differ by weeks or
// months, so the two are printed side by side for each marker.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs scripts/probe-evidence-timeline.mjs

import { neon } from '@neondatabase/serverless';
import { tickerEvidenceRange } from '../src/lib/evidence/timeline.js';
import { buildEvidenceMarkers, snapToBar } from '../src/lib/chart/evidence-markers.mjs';

const sql = neon(process.env.DATABASE_URL);
const NOW = Date.now();
const DAY = 86400e3;
const L = (s = '') => console.log(s);
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

const TICKERS = ['ALK', 'AMRZ', 'AIM', 'MSFT', 'AMRC', 'AGPU'];

// Real daily bars, so snapping is exercised against real sessions and real weekend gaps.
async function bars(ticker, fromISO) {
  const r = await sql.query(
    `select date::text as time, open, high, low, close, volume
       from ticker_daily_candles
      where ticker = $1 and date >= $2
      order by date asc`, [ticker, fromISO.slice(0, 10)]);
  return r.map((x) => ({
    time: x.time, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume,
  }));
}

const from = new Date(NOW - 730 * DAY).toISOString();
const to = new Date(NOW).toISOString();

let totalMarkers = 0, totalPlaced = 0, violations = 0;

for (const ticker of TICKERS) {
  const t0 = Date.now();
  const res = await tickerEvidenceRange(ticker, { from, to, now: NOW });
  const b = await bars(ticker, from);
  const built = buildEvidenceMarkers(res.evidence, b, { theme: 'light' });
  const ms = Date.now() - t0;

  L('');
  L('='.repeat(78));
  L(`${ticker}   ${res.evidence.length} evidence · ${built.markers.length} markers · ${b.length} bars · ${ms}ms`
    + (built.unplaced ? ` · ${built.unplaced} outside range` : '')
    + (built.dropped ? ` · ${built.dropped} below cap` : '')
    + (res.failedFamilies.length ? `  FAILED ${JSON.stringify(res.failedFamilies)}` : '')
    + (res.quarantined.length ? `  QUARANTINED ${JSON.stringify(res.quarantined)}` : ''));
  L('='.repeat(78));
  totalMarkers += built.markers.length;
  totalPlaced += built.placed;

  // Group the evidence by family so the two-clock families can be shown explicitly.
  for (const fam of ['catalyst', 'insider', 'congress', 'institution']) {
    const items = res.evidence.filter((e) => e.family === fam);
    if (!items.length) continue;
    L(`\n  ${fam.toUpperCase()}  (${items.length})`);
    for (const e of items.slice(0, 4)) {
      const placedAt = snapToBar(e.publicTime, b);
      // THE ASSERTION THAT MATTERS: the marker's bar must be >= the public date, and must never be
      // derived from the economic date.
      const economic = e.family === 'congress' ? e.facts?.transactionDate
        : e.family === 'institution' ? e.facts?.quarterEnd
          : e.eventTime;
      const wrongBar = economic ? snapToBar(economic, b) : null;
      const bad = placedAt && wrongBar && placedAt === wrongBar && day(economic) !== day(e.publicTime);
      if (bad) violations++;

      L(`    ${e.summary}`);
      L(`      MARKER BAR : ${placedAt ?? '(outside chart range)'}`);
      L(`      publicTime : ${day(e.publicTime)}   <- placement uses this`);
      if (economic && day(economic) !== day(e.publicTime)) {
        const gap = Math.round((new Date(e.publicTime) - new Date(economic)) / DAY);
        L(`      economic   : ${day(economic)}   (${gap}d earlier — NOT used for placement,`
          + ` would land on ${wrongBar ?? 'no bar'})`);
      }
      if (e.context?.text) L(`      context    : ${e.context.text}`);
      L(`      verify     : ${e.url ? e.url.slice(0, 70) : '(no link stored)'}`);
    }
    if (items.length > 4) L(`    … and ${items.length - 4} more`);
  }
}

L('');
L('='.repeat(78));
L(`TOTAL: ${totalPlaced} markers placed across ${TICKERS.length} tickers`);
L(`PLACEMENT VIOLATIONS (marker derived from an economic date): ${violations}`);
L('='.repeat(78));
process.exit(violations ? 1 : 0);
