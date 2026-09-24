// THE MARKET-WIDE MOVEMENT SNAPSHOT THAT PIT SCAN RANKS.
//
// ── ⚠️ ONE REQUEST FOR THE WHOLE MARKET, NOT ONE PER TICKER OR ONE PER VIEWER ──
//
// The consolidated endpoint answers with roughly 19,600 symbols in a single ~800ms call, so the
// cost of knowing what is moving is one request per TTL — not one per row, and emphatically not one
// per person looking. A thousand viewers and one viewer cost the same, which is the only shape that
// survives an audience. The cache is KV rather than per-instance memory for the same reason: a
// serverless fan-out would otherwise multiply the "one" call by however many instances woke up.
//
// ── ⚠️ WHY MOVING NOW CANNOT BE BUILT FROM THE CONSENSUS BOARD ──────────────
//
// It used to be. Scan read the published Consensus board — about a hundred tickers, all of which
// have evidence by definition — and ranked those by price change. That makes "what is moving right
// now" structurally unable to contain a stock that is moving for a reason no filing explains yet,
// which is most of what moves on any given morning. Price gets a row onto this board; evidence
// explains it when there is evidence to attach.
//
// ── ⚠️ NO VOLUME, AND THEREFORE NO RVOL ─────────────────────────────────────
//
// The consolidated payload's volume is the cumulative day figure, and the provider read drops it
// rather than relabel it (see getAllTickersSnapshot). Nothing here reads, derives or exposes a
// volume, an RVOL, a VWAP or a volume confirmation, and there is no field for one to hide in.

import { kvGetJson, kvSetJson, kvConfigured } from '../consensus/materialization.mjs';
import { TRADEABLE_ASSET_TYPES } from '../heatmap/heatmap-universe.mjs';

export const SNAPSHOT_KEY = 'scan:movement:v1';
export const UNIVERSE_KEY = 'scan:universe:v1';

/**
 * ⚠️ THE TTL IS THE UPSTREAM BUDGET, NOT A RENDERING CHOICE. At 45s a symbol's price can be at most
 * three quarters of a minute behind the tape, and Tiingo sees at most 80 calls an hour from this
 * board however busy the product gets.
 */
export const SNAPSHOT_TTL_SEC = 45;

/** The eligible universe changes on a daily screener rebuild, so it is cached for hours, not seconds. */
export const UNIVERSE_TTL_SEC = 6 * 60 * 60;

/**
 * ⚠️ A PRINT OLDER THAN THIS IS NOT A CURRENT PRICE. A dead or halted symbol keeps returning its
 * last print forever, and ranking that as a mover would put names on the board that are not trading.
 */
export const MAX_QUOTE_AGE_MS = 15 * 60 * 1000;

/**
 * A tripwire for DATA ERRORS, deliberately far outside the range of a real move.
 *
 * ⚠️ IT IS NOT A CAP ON HOW MUCH A STOCK MAY MOVE. A biotech can legitimately double on a readout,
 * and rejecting that would hide exactly the row this board exists to surface. The split-corruption
 * case this is aimed at is handled properly elsewhere: the change is computed against the SAME
 * provider's prevClose from the SAME payload, so both sides of the ratio are adjusted together and
 * a split cannot produce a −99% phantom the way mixing our stored close with a vendor print can.
 */
export const IMPLAUSIBLE_CHANGE_PCT = 500;

/** Sub-penny prints are quote noise, not a price a move can be measured from. */
export const MIN_PRICE = 0.01;

/**
 * Tickers Pit Scan may rank as movers: operating companies we actually cover.
 *
 * ⚠️ THE SAME DEFINITION THE HEATMAP USES, imported rather than restated. ETFs, funds, warrants,
 * rights, units and preferred lines are excluded because they are not operating companies, and a
 * second definition of "a US stock" living in the scanner would drift from the first one.
 */
export async function eligibleUniverse(db, sql, { now = Date.now() } = {}) {
  if (kvConfigured()) {
    const cached = await kvGetJson(UNIVERSE_KEY);
    if (cached && Array.isArray(cached.tickers) && cached.tickers.length) {
      return { tickers: new Set(cached.tickers), at: cached.at, cached: true };
    }
  }
  const res = await db.execute(sql`
    select s.ticker
      from screener_stocks s
      left join screener_meta m on m.ticker = s.ticker
     where coalesce(m.asset_type, '') = any(${`{${TRADEABLE_ASSET_TYPES.join(',')}}`}::text[])
       and coalesce(s.market_cap, m.market_cap) > 0`);
  const tickers = (res.rows ?? res).map((r) => String(r.ticker || '').toUpperCase()).filter(Boolean);
  const at = new Date(now).toISOString();
  if (kvConfigured() && tickers.length) await kvSetJson(UNIVERSE_KEY, { tickers, at }, UNIVERSE_TTL_SEC);
  return { tickers: new Set(tickers), at, cached: false };
}

/**
 * Decide whether one provider row is a price we may rank.
 *
 * Returns the usable row, or null with the reason recorded by the caller. Every rejection is a
 * statement that we could not establish a current price — never a quiet omission.
 */
export function usableMove(row, { now = Date.now() } = {}) {
  // `lastPrice` is the live print WITHOUT the prevClose fallback. Ranking `price` would measure a
  // symbol that has not traded today as a 0% mover, or worse, as a large one.
  const last = row?.lastPrice;
  const prev = row?.prevClose;
  if (!Number.isFinite(last) || last < MIN_PRICE) return null;
  if (!Number.isFinite(prev) || prev < MIN_PRICE) return null;
  const asOf = row?.asOf ? Date.parse(row.asOf) : NaN;
  if (!Number.isFinite(asOf)) return null;
  if (now - asOf > MAX_QUOTE_AGE_MS) return null;
  const changePct = ((last - prev) / prev) * 100;
  if (!Number.isFinite(changePct) || Math.abs(changePct) > IMPLAUSIBLE_CHANGE_PCT) return null;
  return { symbol: row.symbol, last, prevClose: prev, changePct, asOf: row.asOf };
}

/**
 * The cached market-wide movement snapshot, filtered to the eligible universe.
 *
 * @returns {{ at: string, ageMs: number, rows: object[], universe: number, cached: boolean }}
 */
export async function movementSnapshot(db, sql, { now = Date.now(), force = false } = {}) {
  if (!force && kvConfigured()) {
    const cached = await kvGetJson(SNAPSHOT_KEY);
    if (cached?.rows?.length) {
      return { ...cached, ageMs: now - Date.parse(cached.at), cached: true };
    }
  }

  const [{ getAllTickersSnapshot }, universe] = await Promise.all([
    import('../market/tiingo.mjs'),
    eligibleUniverse(db, sql, { now }),
  ]);

  const res = await getAllTickersSnapshot({ consolidated: true });
  if (!res.ok || !Array.isArray(res.rows) || !res.rows.length) {
    return { at: new Date(now).toISOString(), ageMs: 0, rows: [], universe: universe.tickers.size, cached: false, degraded: true, reason: res.reason || 'empty' };
  }

  const rows = [];
  let rejectedStale = 0, rejectedPrice = 0, offUniverse = 0;
  for (const r of res.rows) {
    if (!universe.tickers.has(r.symbol)) { offUniverse++; continue; }
    const ok = usableMove(r, { now });
    if (!ok) {
      if (Number.isFinite(r?.lastPrice)) rejectedStale++; else rejectedPrice++;
      continue;
    }
    rows.push(ok);
  }

  const snap = {
    at: new Date(now).toISOString(),
    rows,
    universe: universe.tickers.size,
    // Kept so the board can say what it looked at rather than implying the market is this small.
    stats: { provided: res.rows.length, offUniverse, rejectedStale, rejectedPrice, usable: rows.length },
  };
  if (kvConfigured() && rows.length) await kvSetJson(SNAPSHOT_KEY, snap, SNAPSHOT_TTL_SEC);
  return { ...snap, ageMs: 0, cached: false };
}
