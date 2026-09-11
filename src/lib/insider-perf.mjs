// src/lib/insider-perf.mjs
// Subsequent-performance for an insider trade: % from the transaction price to the closing price
// at +1d / +1w / +1m / +6m. A horizon still in the future stays null (fills in once it elapses).
// Pure — bars come from the caller (Polygon daily, split-adjusted, ascending).

const HORIZONS = { p1d: 1, p1w: 7, p1m: 30, p6m: 180 };

export function computePerf(bars, tradeDate, basis, todayISO) {
  const out = { p1d: null, p1w: null, p1m: null, p6m: null };
  if (!(basis > 0) || !tradeDate || !bars || !bars.length) return out;
  // neon returns date columns as Date objects; normalize to YYYY-MM-DD either way.
  const tISO = typeof tradeDate === 'string' ? tradeDate.slice(0, 10) : new Date(tradeDate).toISOString().slice(0, 10);
  const t0 = new Date(tISO + 'T00:00:00Z');
  if (isNaN(t0)) return out;
  const todayMs = new Date(todayISO + 'T00:00:00Z').getTime();
  for (const [k, days] of Object.entries(HORIZONS)) {
    const target = new Date(t0); target.setUTCDate(target.getUTCDate() + days);
    if (target.getTime() > todayMs) continue;                 // horizon not reached yet → leave null
    const ts = target.toISOString().slice(0, 10);
    const bar = bars.find((b) => b.date >= ts);               // first close on/after the target date
    if (!bar) continue;
    out[k] = +(((bar.c - basis) / basis) * 100).toFixed(1);
  }
  return out;
}
