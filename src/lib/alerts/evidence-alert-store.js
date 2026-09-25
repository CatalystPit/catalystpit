// EVIDENCE ALERTS — persistence. Subscriptions, delivered alerts, read state.
//
// Two tables, and the constraints on them are the product guarantees:
//
//   uq_evidence_alert_sub   (user_id, ticker)        one subscription per person per ticker
//   uq_evidence_alert       (user_id, evidence_id)   one alert per person per real-world event
//
// ⚠️ BOTH GUARANTEES LIVE IN POSTGRES, NOT IN THE WORKER. A worker that runs twice, a deploy that
// overlaps a cron, a retry after a timeout — all of them re-process the same evidence, and the
// brief's rule is that the second processing must be harmless. An ON CONFLICT DO NOTHING against a
// unique index is harmless by construction; a "have I sent this already?" check in application
// code is a race with itself.
//
// ⚠️ AND THE TABLES ARE CREATED IDEMPOTENTLY AT RUNTIME, which is this codebase's existing pattern
// (see lib/alerts.js ensureAlertTables, lib/notifications.js ensureNotifTables) rather than a
// migration that has to be applied before the deploy that needs it.

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { RETENTION_DAYS, UNREAD_RETENTION_DAYS } from './evidence-alerts.mjs';

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
export const MAX_SUBS_PER_USER = 200;
export const INBOX_LIMIT = 50;

export function normalizeTicker(t) {
  const s = String(t || '').trim().toUpperCase();
  return TICKER_RE.test(s) ? s : null;
}

let _ensured = false;
export async function ensureEvidenceAlertTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS evidence_alert_subs (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    -- ⚠️ THE WATERMARK, AND IT IS NOT created_at. Re-enabling a subscription must start the clock
    -- again: a person who turned alerts off in March and back on today asked to hear about today,
    -- not to receive four months of backlog the moment they clicked. created_at stays as the
    -- first-ever subscription so the row's history is not rewritten by a toggle.
    enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_alert_sub
    ON evidence_alert_subs (user_id, ticker)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_evidence_alert_subs_ticker
    ON evidence_alert_subs (ticker) WHERE enabled`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS evidence_alerts (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    family TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    url TEXT,
    public_time TIMESTAMPTZ NOT NULL,
    read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_alert
    ON evidence_alerts (user_id, evidence_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_evidence_alerts_user
    ON evidence_alerts (user_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_evidence_alerts_unread
    ON evidence_alerts (user_id) WHERE NOT read`);
  _ensured = true;
}

/**
 * Every ticker this person is subscribed to.
 *
 * ⚠️ ONE REQUEST SERVES EVERY SURFACE. Pit Scan rows, watchlist rows and the ticker page all need
 * to know "is this one on?", and asking per ticker would be the N+1 the brief forbids. The set is
 * small and bounded, so it is returned whole and every row reads it from memory.
 */
export async function listSubscriptions(userId) {
  await ensureEvidenceAlertTables();
  const r = await db.execute(sql`
    select ticker from evidence_alert_subs
     where user_id = ${userId} and enabled order by ticker`);
  return (r.rows ?? r).map((x) => x.ticker);
}

/**
 * Turn a subscription on or off. Returns the resulting enabled state.
 *
 * ⚠️ ONE ROW PER USER/TICKER, ENFORCED BY THE INDEX AND NOT BY A READ-THEN-WRITE. Two clicks
 * racing each other cannot produce two subscriptions; the second becomes an update of the first.
 */
export async function setSubscription(userId, ticker, enabled) {
  await ensureEvidenceAlertTables();
  const sym = normalizeTicker(ticker);
  if (!sym) throw new Error('invalid ticker');
  if (enabled) {
    const [{ n }] = (await db.execute(sql`
      select count(*)::int as n from evidence_alert_subs
       where user_id = ${userId} and enabled and ticker <> ${sym}`)).rows;
    if (n >= MAX_SUBS_PER_USER) throw new Error(`limit of ${MAX_SUBS_PER_USER} alerts reached`);
  }
  await db.execute(sql`
    insert into evidence_alert_subs (user_id, ticker, enabled, enabled_at)
    values (${userId}, ${sym}, ${!!enabled}, now())
    on conflict (user_id, ticker) do update
      -- ⚠️ enabled_at MOVES ONLY WHEN TURNING ON. Re-saving an already-on subscription must not
      -- slide the watermark forward, or a stray click would silently skip pending evidence.
      set enabled = excluded.enabled,
          enabled_at = case when excluded.enabled and not evidence_alert_subs.enabled
                            then now() else evidence_alert_subs.enabled_at end`);
  return !!enabled;
}

/**
 * Active subscriptions grouped for the worker: one row per (ticker, user) with the watermark.
 *
 * ⚠️ ONE STATEMENT FOR EVERY SUBSCRIPTION IN THE SYSTEM. The worker needs to know which tickers to
 * resolve and, for each, who is waiting and since when. Reading that per user or per ticker is the
 * N+1 the brief forbids, and it is entirely avoidable — this is a single ordered scan.
 */
export async function activeSubscriptions({ limit = 5000 } = {}) {
  await ensureEvidenceAlertTables();
  const r = await db.execute(sql`
    select user_id, ticker, enabled_at from evidence_alert_subs
     where enabled order by ticker limit ${limit}`);
  return (r.rows ?? r).map((x) => ({ userId: x.user_id, ticker: x.ticker, since: x.enabled_at }));
}

/**
 * Persist alerts, skipping any this person already has for the same canonical event.
 *
 * @returns the number of rows that were genuinely new.
 *
 * ⚠️ ONE STATEMENT FOR THE WHOLE BATCH, AND DUPLICATES ARE A NO-OP RATHER THAN AN ERROR.
 */
export async function insertAlerts(rows) {
  if (!rows?.length) return 0;
  await ensureEvidenceAlertTables();
  const values = rows.map((a) => sql`(${a.userId}, ${a.ticker}, ${a.evidenceId}, ${a.family},
    ${a.title}, ${a.detail}, ${a.url}, ${a.publicTime}::timestamptz)`);
  const r = await db.execute(sql`
    insert into evidence_alerts (user_id, ticker, evidence_id, family, title, detail, url, public_time)
    values ${sql.join(values, sql`, `)}
    on conflict (user_id, evidence_id) do nothing
    returning id`);
  return (r.rows ?? r).length;
}

/** The inbox: newest first, bounded. Reads persisted rows — never the Evidence Engine. */
export async function listAlerts(userId, { limit = INBOX_LIMIT } = {}) {
  await ensureEvidenceAlertTables();
  const r = await db.execute(sql`
    select id, ticker, evidence_id, family, title, detail, url, public_time, read, created_at
      from evidence_alerts where user_id = ${userId}
     order by created_at desc, id desc limit ${Math.min(200, Math.max(1, limit))}`);
  return (r.rows ?? r).map((x) => ({
    id: x.id, ticker: x.ticker, evidenceId: x.evidence_id, family: x.family,
    title: x.title, detail: x.detail, url: x.url,
    publicTime: x.public_time, read: x.read, createdAt: x.created_at,
  }));
}

export async function unreadAlertCount(userId) {
  await ensureEvidenceAlertTables();
  const r = await db.execute(sql`
    select count(*)::int as n from evidence_alerts where user_id = ${userId} and not read`);
  return (r.rows ?? r)[0]?.n || 0;
}

/**
 * Mark one alert, or all of them, read.
 *
 * ⚠️ SCOPED TO THE OWNER IN THE STATEMENT. An id is a guessable integer, so the user_id predicate
 * is what stops one person marking another's alerts read; it is not there for tidiness.
 */
export async function markRead(userId, { id = null, all = false } = {}) {
  await ensureEvidenceAlertTables();
  if (all) {
    await db.execute(sql`update evidence_alerts set read = true where user_id = ${userId} and not read`);
    return true;
  }
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return false;
  await db.execute(sql`update evidence_alerts set read = true where user_id = ${userId} and id = ${n}`);
  return true;
}

/**
 * Bounded history.
 *
 * ⚠️ UNREAD ALERTS ARE KEPT THREE TIMES LONGER. Pruning something a person has not seen is
 * deleting the thing they asked for, so read rows age out at 30 days and unread ones at 90.
 */
export async function pruneAlerts() {
  await ensureEvidenceAlertTables();
  const r = await db.execute(sql`
    delete from evidence_alerts
     where (read and created_at < now() - make_interval(days => ${RETENTION_DAYS}))
        or (not read and created_at < now() - make_interval(days => ${UNREAD_RETENTION_DAYS}))
    returning id`);
  return (r.rows ?? r).length;
}
