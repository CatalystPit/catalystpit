// Backfill dividend-and-split-adjusted closes for the Safe-Haven Demand component.
//
//   node --env-file=.env.local --loader ./scripts/ext-resolve-loader.mjs scripts/backfill-fg-adjusted.mjs [--write]
//
// Read-only without --write. Reports coverage, proves the adjustment is real by comparing against
// the split-adjusted bars we already hold, and refuses to write a symbol whose fetch failed.
import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db.js';
import {
  ensureAdjustedTable, fetchAdjustedCloses, saveAdjustedCloses, adjustedCoverage,
  loadAdjustedCloses, ADJUSTED_SYMBOLS,
} from '../src/lib/fear-greed/adjusted-store.mjs';
import { loadCloses } from '../src/lib/fear-greed/data.mjs';

const WRITE = process.argv.includes('--write');
const L = (s = '') => console.log(s);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

await ensureAdjustedTable(db);
L(`[fg-adj] table ready. mode: ${WRITE ? 'WRITE' : 'dry run'}`);
L();

for (const sym of ADJUSTED_SYMBOLS) {
  const { rows: got, error } = await fetchAdjustedCloses(sym);
  if (error || !got.length) {
    L(`[fg-adj] ${sym}: fetch failed (${error}) — NOT WRITTEN, existing rows untouched`);
    continue;
  }
  L(`[fg-adj] ${sym}: ${got.length} adjusted sessions ${got[0].date} → ${got.at(-1).date}`);

  // ⚠️ PROVE THE SERIES IS ACTUALLY TOTAL RETURN, by comparing with the split-adjusted bars we hold.
  // If the two agree on long-horizon return, the adjustment did not happen and the fetch is wrong.
  const priceOnly = await loadCloses(db, sql, sym, { sinceDays: 12500 });
  if (priceOnly.length > 250) {
    const pm = new Map(priceOnly.map((b) => [b.date, b.close]));
    const shared = got.filter((r) => pm.has(r.date));
    if (shared.length > 250) {
      const a = shared[0], z = shared.at(-1);
      const trRet = z.adj / a.adj - 1;
      const prRet = pm.get(z.date) / pm.get(a.date) - 1;
      const yrs = (new Date(z.date) - new Date(a.date)) / (365.25 * 864e5);
      const carry = ((1 + trRet) / (1 + prRet)) ** (1 / yrs) - 1;
      L(`            over ${shared.length} shared sessions (${yrs.toFixed(1)}y): total return ${(100 * trRet).toFixed(0)}%`
        + `  price-only ${(100 * prRet).toFixed(0)}%  implied income ${(100 * carry).toFixed(2)}%/yr`);
      // ⚠️ DAILY RETURNS MUST STILL MATCH ON NON-EX-DATES. A wholesale mismatch would mean the two
      // series are different instruments, not different adjustment bases.
      let agree = 0, checked = 0;
      for (let i = 1; i < shared.length; i++) {
        const pa = pm.get(shared[i - 1].date), pb = pm.get(shared[i].date);
        if (!pa || !pb) continue;
        const ra = Math.log(shared[i].adj / shared[i - 1].adj);
        const rp = Math.log(pb / pa);
        checked++;
        if (Math.abs(ra - rp) < 1e-4) agree++;
      }
      L(`            daily returns identical on ${(100 * agree / checked).toFixed(1)}% of sessions`
        + `  (the rest are distribution dates — ${checked - agree} of ${checked})`);
      if (sym !== 'GLD' && agree === checked) {
        L(`            ⚠️ REFUSING ${sym}: every daily return matches the price-only series, so this is`);
        L(`               NOT a total-return series. Not written.`);
        continue;
      }
    }
  }

  if (WRITE) {
    const n = await saveAdjustedCloses(db, sym, got);
    L(`            wrote ${n} rows`);
  }
  L();
}

L('[fg-adj] coverage now:');
for (const c of await adjustedCoverage(db))
  L(`   ${c.ticker.padEnd(5)} ${String(c.n).padStart(5)} rows  ${c.first} → ${c.last}`);
L();
// the shared calendar the component will actually run on
const series = {};
for (const s of ADJUSTED_SYMBOLS) series[s] = await loadAdjustedCloses(db, s);
if (ADJUSTED_SYMBOLS.every((s) => series[s].length)) {
  const maps = Object.fromEntries(ADJUSTED_SYMBOLS.map((s) => [s, new Map(series[s].map((b) => [b.date, b.close]))]));
  const cal = series.SPY.map((b) => b.date).filter((d) => ADJUSTED_SYMBOLS.every((s) => maps[s].has(d)));
  L(`[fg-adj] shared calendar for the component: ${cal.length} sessions ${cal[0]} → ${cal.at(-1)}`);
  L(`         with a 20-session lookback and a 504-session window that is ${Math.max(0, cal.length - 20 - 503)} scoreable sessions`);
}
if (!WRITE) L('\n[fg-adj] dry run — nothing written. Re-run with --write.');
process.exit(0);
