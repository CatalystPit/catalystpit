import { sql } from 'drizzle-orm';
import { db } from '../db';
import { LICENSED_CANDLE_SOURCES_SQL } from '../licensing/providers.mjs';
import { pickSessionDates } from './session-quorum.mjs';

/**
 * THE LAST COMPLETED SESSION'S ACTUAL RETURN, FOR VISITORS WHO ARE NOT SERVED A LIVE PRICE.
 *
 * ── ⚠️ THE BUG THIS EXISTS TO FIX ────────────────────────────────────────────────────────────────
 *
 * getQuotes() serves `prevClose` as the price to anyone without a real-time entitlement, which is
 * correct — a live print we are not licensed to redistribute must not reach a page. The change
 * percentage was then computed as `(price - prevClose) / prevClose`, and with price === prevClose
 * that is exactly zero. Every ticker on the homepage snapshot and every watchlist row read 0.00%,
 * on days when the market had moved several percent.
 *
 * Nothing was wrong with the price. The comparison was: a close against itself.
 *
 * The honest figure for someone looking at a settled close is what that session actually did —
 * close against the close BEFORE it — and the two closes needed are already on disk.
 *
 * ── ⚠️ IT READS CANDLES, NOT A SECOND PROVIDER ───────────────────────────────────────────────────
 *
 * ticker_daily_candles, filtered to licensed sources only, so no new vendor and no new licensing
 * question. It reuses pickSessionDates for exactly the reason that function exists: a weekend bar
 * from a 24/7 symbol must not be mistaken for a market session. Without the quorum rule this would
 * happily compute "Saturday versus Friday" for one ticker and nothing for the rest.
 *
 * ── ⚠️ AND IT NEVER RETURNS ZERO FOR "UNKNOWN" ───────────────────────────────────────────────────
 *
 * A symbol with one stored close, or none, is ABSENT from the result rather than present with 0.
 * Zero is a real and meaningful market outcome — a stock that genuinely closed flat — so using it
 * to mean "we could not work this out" destroys the only value that should render as 0.00%. The
 * caller shows a dash for absent, which is what the UI already does for null.
 */

/** How many recent dates to consider when identifying the last two real sessions. */
const LOOKBACK_DATES = 30;

/**
 * @param {string[]} symbols
 * @returns {Promise<Map<string, {close:number, prevClose:number, changePct:number, session:string, prevSession:string}>>}
 */
export async function lastSessionChange(symbols) {
  const syms = [...new Set((symbols || []).map((s) => String(s).toUpperCase().trim()).filter(Boolean))];
  const out = new Map();
  if (!syms.length) return out;

  // ⚠️ THE SESSIONS ARE CHOSEN MARKET-WIDE, NOT PER SYMBOL. Picking each ticker's own two most
  // recent bars would compare a halted name's September close against its August one and present
  // the result beside today's movers as though both described the same day. One pair of dates for
  // everybody means every figure on the page describes the same session.
  const counted = await db.execute(sql`
    select date::text as date, count(*)::int as n
      from ticker_daily_candles
     where source = any(${sql.raw(LICENSED_CANDLE_SOURCES_SQL)})
     group by date order by date desc limit ${LOOKBACK_DATES}`);
  const dates = pickSessionDates((counted.rows ?? counted).map((r) => ({ date: r.date, n: Number(r.n) })), 2);
  if (dates.length < 2) return out;                 // one session is no change; say nothing

  const [session, prevSession] = dates;
  const list = sql`${`{${syms.map((s) => `"${s.replace(/["\\]/g, '')}"`).join(',')}}`}::text[]`;
  const res = await db.execute(sql`
    select ticker, date::text as date, close
      from ticker_daily_candles
     where source = any(${sql.raw(LICENSED_CANDLE_SOURCES_SQL)})
       and ticker = any(${list})
       and date::text in (${session}, ${prevSession})`);

  const closes = new Map();                          // sym -> { [date]: close }
  for (const r of (res.rows ?? res)) {
    const sym = String(r.ticker).toUpperCase();
    const c = Number(r.close);
    if (!Number.isFinite(c) || c <= 0) continue;     // a non-positive close is not a close
    const bucket = closes.get(sym) || {};
    bucket[r.date] = c;
    closes.set(sym, bucket);
  }

  for (const [sym, bucket] of closes) {
    const close = bucket[session];
    const prior = bucket[prevSession];
    // ⚠️ BOTH LEGS REQUIRED. A symbol that did not trade one of the two sessions has no return for
    // it, and inventing one by reaching further back would silently compare different days for
    // different tickers.
    if (close == null || prior == null || prior <= 0) continue;
    out.set(sym, {
      close,
      prevClose: prior,
      changePct: ((close - prior) / prior) * 100,
      session,
      prevSession,
    });
  }
  return out;
}
