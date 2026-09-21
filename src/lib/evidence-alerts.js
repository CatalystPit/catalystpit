import { sql } from 'drizzle-orm';
import { db } from './db';
import { watchlist, pitNotifications } from './schema';
import { tickerEvidence } from './evidence/resolve';
import { isIngestableTicker } from './security-identity.mjs';
import { ensureNotifTables } from './notifications';
// The pure decisions — which families alert, what makes an event unique, how the line reads —
// live in a module with no imports so they can be tested without a database. Re-exported so
// callers still have one place to import from.
import {
  ALERTABLE_FAMILIES, LOOKBACK_HOURS, MAX_TICKERS, CONCURRENCY, MAX_ALERTS_PER_RUN,
  alertKey, insiderAccessionKey, alertBody,
} from './evidence-alert-rules.mjs';
export {
  ALERTABLE_FAMILIES, LOOKBACK_HOURS, MAX_TICKERS, CONCURRENCY, MAX_ALERTS_PER_RUN,
  alertKey, insiderAccessionKey, alertBody,
};

// EVIDENCE ALERTS — "tell me when something public lands on a name I watch".
//
// ── ONE EVENT, ONE ALERT, ENFORCED BY A PRIMARY KEY ─────────────────────────
//
// Dedupe is not application logic here. `evidence_alerts_sent` has a primary key of
// (user_id, alert_key) and every send is an INSERT … ON CONFLICT DO NOTHING that RETURNS the row.
// A row comes back exactly once, ever, per user per event — so the notification is written only by
// the pass that won the insert. Two crons overlapping, a retry after a timeout, a re-run against
// the same window: all converge on one alert, because the database decides, not a watermark.
//
// That also removes the usual fragility of "notify since X". The window below can be generous and
// can overlap itself; re-seeing an event is free. A lost or stale watermark degrades to re-checking
// events that were already delivered, which the primary key absorbs — instead of degrading to
// silence, which is how a missed filing becomes invisible forever.
//
// ── AND IT IS SHARED WITH THE FORM 4 EMAIL ──────────────────────────────────
//
// The insider-alerts mailer already emails watchers about new open-market Form 4s. Its filings and
// this engine's insider evidence are the SAME accessions, so without a shared key a watcher would
// get an email and a bell for one filing. Both paths now write the same key —
// `insider:<accession>` — so whichever runs first owns that event and the other skips it.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
//
// ⚠️ WATCHED TICKERS ONLY, NEVER THE UNIVERSE. Every query below starts from a user's watchlist.
// There is no market-wide path and no place to add one without rewriting the entry point.
//
// ⚠️ NO PRICE, NO VOLUME, NO RVOL. Every alert is a public disclosure with a filing behind it.
// Realtime is not entitled, so a "moving now" alert could only ever be a claim about a stale
// quote — see the alert types that were removed from the picker for exactly that reason.

let _ensured = false;
export async function ensureEvidenceAlertTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS evidence_alerts_sent (
    user_id TEXT NOT NULL,
    alert_key TEXT NOT NULL,
    ticker TEXT,
    family TEXT,
    channel TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, alert_key)
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_evidence_alerts_sent_at ON evidence_alerts_sent (sent_at)`);
  _ensured = true;
}

/**
 * Claim an event for a user. Returns true exactly once, ever.
 *
 * The INSERT is the claim. Nothing is notified unless this returns true, so a crash between the
 * claim and the notification loses one alert rather than repeating it forever — the safer side of
 * that trade for something that interrupts a person.
 */
export async function claim(userId, key, { ticker = null, family = null, channel = 'in_app' } = {}) {
  const res = await db.execute(sql`
    insert into evidence_alerts_sent (user_id, alert_key, ticker, family, channel)
    values (${userId}, ${key}, ${ticker}, ${family}, ${channel})
    on conflict (user_id, alert_key) do nothing
    returning alert_key`);
  return (res.rows ?? res).length > 0;
}

/**
 * Run one pass for every user who watches anything.
 *
 * @param {object} o
 * @param {number} o.now             clock, for tests
 * @param {Function} o._resolve      injected Evidence Engine, for tests
 * @param {Function} o._notify       injected notifier, for tests
 */
export async function runEvidenceAlerts({
  now = Date.now(),
  limit = MAX_ALERTS_PER_RUN,
  _resolve = tickerEvidence,
  _notify = null,
} = {}) {
  await ensureEvidenceAlertTables();
  await ensureNotifTables();

  const since = new Date(now - LOOKBACK_HOURS * 3600e3).toISOString();
  const rows = await db.select({ userId: watchlist.userId, ticker: watchlist.ticker }).from(watchlist).limit(2000);

  // Group by user, and drop anything that is not a symbol before it reaches the engine.
  const byUser = new Map();
  for (const r of rows) {
    if (!isIngestableTicker(r.ticker)) continue;
    const t = r.ticker.toUpperCase();
    if (!byUser.has(r.userId)) byUser.set(r.userId, new Set());
    byUser.get(r.userId).add(t);
  }

  // One resolver call per DISTINCT ticker, not per watcher — two users watching TELA is one
  // resolve, then two independent claims.
  const wanted = [...new Set([...byUser.values()].flatMap((s) => [...s]))].slice(0, MAX_TICKERS);
  const evidenceByTicker = new Map();
  for (let i = 0; i < wanted.length; i += CONCURRENCY) {
    await Promise.all(wanted.slice(i, i + CONCURRENCY).map(async (t) => {
      try {
        const r = await _resolve(t, { now, since });
        evidenceByTicker.set(t, (r?.evidence || []).filter((e) => ALERTABLE_FAMILIES.includes(e.family)));
      } catch (e) {
        // A resolver failure is not "nothing happened" — it is reported and retried next pass,
        // and because nothing was claimed the event is still deliverable.
        console.log(`[evidence-alerts] ${t}: ${e.message}`);
      }
    }));
  }

  let fired = 0;
  const failures = [];
  for (const [userId, tickers] of byUser) {
    for (const ticker of tickers) {
      for (const ev of evidenceByTicker.get(ticker) || []) {
        if (fired >= limit) return { users: byUser.size, tickers: wanted.length, fired, capped: true, failures };
        const key = alertKey(ev);
        if (!key) continue;
        try {
          if (!(await claim(userId, key, { ticker, family: ev.family }))) continue;
          const message = alertBody(ticker, ev);
          if (_notify) await _notify(userId, message, ev);
          else {
            await db.insert(pitNotifications).values({
              userId, actorUserId: 'system', actorName: 'Pit Evidence',
              type: 'alert', excerpt: message,
            });
          }
          fired++;
        } catch (e) { failures.push({ ticker, error: e.message }); }
      }
    }
  }
  return { users: byUser.size, tickers: wanted.length, fired, capped: false, failures };
}
