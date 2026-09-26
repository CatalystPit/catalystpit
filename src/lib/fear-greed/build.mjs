// FEAR & GREED — the one entry point that computes and materialises the index.
//
// Called by the cron. Nothing else calls it, and no read path does.

import { sql } from 'drizzle-orm';
import { db } from '../db';
import {
  loadPanelSeries, loadCloses, MARKET_SYMBOL, CREDIT_RISK_SYMBOL, CREDIT_SAFE_SYMBOL,
  VOL_MARKET_SYMBOL, VOL_MARKET_WARMUP_DAYS,
} from './data.mjs';
import { rawSeries, buildPayload, indexHistory } from './compute.mjs';
import { saveHistory, savePayload } from './store.mjs';

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
    loadCloses(dbc, sqlc, MARKET_SYMBOL, {}),
    // Deeper than the rest, and only because this instrument's stored history starts later — see
    // VOL_MARKET_WARMUP_DAYS. It changes the reach of the query, not any calculation.
    loadCloses(dbc, sqlc, VOL_MARKET_SYMBOL, { sinceDays: VOL_MARKET_WARMUP_DAYS }),
    loadCloses(dbc, sqlc, CREDIT_RISK_SYMBOL, {}),
    loadCloses(dbc, sqlc, CREDIT_SAFE_SYMBOL, {}),
  ]);
  const loadMs = Date.now() - t0;

  const t1 = Date.now();
  const series = rawSeries({ panel, spy, volMarket, credit: { risk, safe } });
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
    eligible: panel.at(-1)?.eligible ?? null,
  };
}
