// FEAR & GREED — the one entry point that computes and materialises the index.
//
// Called by the cron. Nothing else calls it, and no read path does.

import { sql } from 'drizzle-orm';
import { db } from '../db';
import {
  loadPanelSeries, loadCloses, MARKET_SYMBOL, CREDIT_RISK_SYMBOL, CREDIT_SAFE_SYMBOL,
  VOL_MARKET_SYMBOL, VOL_MARKET_WARMUP_DAYS, MARKET_WARMUP_DAYS,
  SAFE_HAVEN_EQUITY_SYMBOL, SAFE_HAVEN_DEFENSIVE_SYMBOLS,
} from './data.mjs';
import { rawSeries, buildPayload, indexHistory } from './compute.mjs';
import { loadOptionsVolume, ingestSessions } from './occ-store.mjs';
import { loadAdjustedCloses, refreshAdjusted, ensureAdjustedTable } from './adjusted-store.mjs';
import { saveHistory, savePayload } from './store.mjs';

/**
 * How many recent sessions the nightly build offers to OCC.
 *
 * ⚠️ BOUNDED, AND WIDER THAN THE PUBLICATION LAG. Already-stored sessions are filtered out before
 * a single request is made, so on a normal night this is one or two calls; the width only matters
 * after an outage, when it is what lets the record catch up without a manual backfill.
 */
const OCC_INGEST_WINDOW = 15;

/**
 * Compute the index across all available sessions, store the history, publish the payload.
 *
 * ⚠️ PUBLISH ONLY WHAT COMPUTED. An unavailable index writes nothing and reports why, leaving the
 * previous payload in place — the same discipline the Consensus board uses. A day when the market
 * data is broken must not overwrite a good reading with a blank one.
 */
export async function buildFearGreed({ dbc = db, sqlc = sql } = {}) {
  const t0 = Date.now();
  const [panel, spy, volMarket, risk, safe] = await Promise.all([
    loadPanelSeries(dbc, sqlc, {}),
    // Full stored history, not the default reach — see MARKET_WARMUP_DAYS. Momentum and Realized
    // Volatility were both scoring a fraction of the sessions they could, purely because of how
    // far this query looked back. It changes no score that already had a full window.
    loadCloses(dbc, sqlc, MARKET_SYMBOL, { sinceDays: MARKET_WARMUP_DAYS }),
    // Deeper than the rest, and only because this instrument's stored history starts later — see
    // VOL_MARKET_WARMUP_DAYS. It changes the reach of the query, not any calculation.
    loadCloses(dbc, sqlc, VOL_MARKET_SYMBOL, { sinceDays: VOL_MARKET_WARMUP_DAYS }),
    loadCloses(dbc, sqlc, CREDIT_RISK_SYMBOL, {}),
    loadCloses(dbc, sqlc, CREDIT_SAFE_SYMBOL, {}),
  ]);

  // ── ⚠️ TOTAL-RETURN LEGS FOR SAFE-HAVEN DEMAND, FROM THEIR OWN STORE ──────
  //
  // Separate from everything above because the basis is different: these are dividend-adjusted
  // closes, and the candle table is split-adjusted only. If the adjusted store is empty the arrays
  // are empty, the component is absent, and the existing missing-component rule carries the index
  // on the others — no substitution, no fallback to price-only bars.
  // ⚠️ REFRESH BEFORE READING, or the component freezes at whatever the backfill left behind.
  // Same shape as the OCC ingest above: bounded, upserting, and a failure degrades to the
  // component being absent rather than to a stale number presented as current.
  let adjusted = { asked: 0, stored: 0, failed: 0, symbols: {} };
  try {
    await ensureAdjustedTable(dbc);
    adjusted = await refreshAdjusted(dbc);
  } catch (e) {
    console.warn(`[fear-greed] adjusted refresh skipped: ${e.message}`);
  }

  const [shEquity, ...shDefensive] = await Promise.all([
    loadAdjustedCloses(dbc, SAFE_HAVEN_EQUITY_SYMBOL),
    ...SAFE_HAVEN_DEFENSIVE_SYMBOLS.map((sym) => loadAdjustedCloses(dbc, sym)),
  ]);

  // ── ⚠️ ASK OCC ONLY FOR SESSIONS WE DO NOT ALREADY HOLD ───────────────────
  //
  // Cleared volume for a published session never changes, so the durable record is the cache: a
  // nightly run asks for the handful of recent sessions that are still missing and nothing else.
  // The window is the reporting calendar's tail, which is bounded by construction.
  //
  // ⚠️ AND A FAILURE HERE IS NOT AN INDEX FAILURE. If OCC is unreachable, or has not published a
  // session yet, nothing is written, the series simply lacks those points, and the composite runs
  // on the components it has. There is no fallback value anywhere in this path.
  let occ = { asked: 0, stored: 0, unpublished: 0, failed: 0 };
  try {
    const recent = panel.slice(-OCC_INGEST_WINDOW).map((p) => String(p.date));
    occ = await ingestSessions(recent, { dbc, limit: OCC_INGEST_WINDOW });
  } catch (e) {
    console.warn(`[fear-greed] OCC ingest skipped: ${e.message}`);
  }
  const options = await loadOptionsVolume(dbc, {}).catch(() => []);
  const loadMs = Date.now() - t0;

  const t1 = Date.now();
  const series = rawSeries({ panel, spy, volMarket, options, credit: { risk, safe },
    safeHaven: { equity: shEquity, defensive: shDefensive } });
  const payload = buildPayload(series);
  const history = indexHistory(series);
  const computeMs = Date.now() - t1;

  if (!payload.available) {
    return {
      published: false, reason: payload.reason, loadMs, computeMs,
      sessions: history.length, componentCount: payload.componentCount,
    };
  }

  const saved = await saveHistory(history);
  const cached = await savePayload(payload);
  return {
    published: true, reason: 'ok', loadMs, computeMs,
    ms: Date.now() - t0,
    asOf: payload.asOf, score: payload.score, zone: payload.zone?.label ?? null,
    componentCount: payload.componentCount,
    sessions: history.length, written: saved.written, skipped: saved.skipped, cached,
    panelSessions: panel.length,
    volMarketSessions: volMarket.length,
    optionsSessions: options.length,
    occ,
    adjusted,
    eligible: panel.at(-1)?.eligible ?? null,
  };
}
