// THE EMAIL CHANNEL'S DELIVERY LEDGER. Nothing else lives here any more.
//
// ── WHAT THIS FILE USED TO BE, AND WHY IT IS NOW FOUR FUNCTIONS ─────────────
//
// It was a second, watchlist-driven evidence alerter: it read every user's watchlist, resolved
// evidence for those tickers and wrote in-app notifications. It delivered in production until
// 2026-09-25 (12 notifications, actor_name 'Pit Evidence'), and then /api/cron/evidence-alerts was
// repointed at lib/alerts/evidence-alert-worker.mjs — which is driven by EXPLICIT per-ticker
// subscriptions and is Pro-gated. Its `runEvidenceAlerts` was left behind, uncalled, exporting the
// same name as the live worker: importing the wrong one would have silently restored
// watchlist-driven, non-Pro-gated alerting. It has been removed.
//
// ⚠️ AND IT CARRIED A CONTRADICTORY POLICY. ./evidence-alert-rules.mjs declared
// ALERTABLE_FAMILIES = ['catalyst','insider','congress'] under the heading "13F IS NOT AN ALERT",
// while the live path includes FAMILY.INSTITUTION. Two answers to one product question, one of them
// dead. The owner's rule is that institutional activity CAN alert when it qualifies, so the dead
// module was deleted rather than reconciled. There is now exactly one ALERTABLE_FAMILIES in the
// codebase, in lib/alerts/evidence-alerts.mjs, and it is the only policy.
//
// What remains is the ledger the Form 4 mailer needs, and only that.
//
// ── ONE EVENT, ONE DELIVERY, PER CHANNEL, ENFORCED BY A PRIMARY KEY ─────────
//
// `evidence_alerts_sent` has a primary key of (user_id, alert_key) and every send is an
// INSERT … ON CONFLICT DO NOTHING that RETURNS the row, so a row comes back exactly once per user per
// key. The channel is part of the KEY rather than merely a column — see channelKey below — because
// email and in-app are separate deliveries and neither may silence the other.

import { sql } from 'drizzle-orm';
import { db } from './db';

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
 * The key the Form 4 mailer writes for one filing.
 *
 * ⚠️ THE ACCESSION, NOT THE SUMMARY. The accession identifies the DOCUMENT; keying on summary text
 * would re-deliver whenever the wording changed.
 */
export const insiderAccessionKey = (accession) => `insider:${accession}`;

/**
 * ⚠️ THE CHANNEL IS PART OF THE KEY, SO ONE CHANNEL CAN NEVER SILENCE ANOTHER.
 *
 * The primary key is (user_id, alert_key) and `channel` was only a column — so an email claim and an
 * in-app claim for the same filing were THE SAME ROW, and whichever delivered first suppressed the
 * other. The product rule is the opposite: they are separate channels and a user who asked for both
 * gets both. Putting the channel inside the key makes that structural rather than a convention.
 *
 * Within a channel the key still collapses one real-world event to one delivery, which is the
 * guarantee that matters and the reason this table has a primary key at all.
 */
export const channelKey = (channel, key) => `${channel}:${key}`;

/**
 * Claim an event for a user on a channel. Returns true exactly once, ever.
 *
 * The INSERT is the claim. The caller notifies only when this returns true, or claims only after a
 * successful delivery — either way a crash between the two loses one delivery rather than repeating
 * it forever, which is the safer side of that trade for something that interrupts a person.
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
 * Which of these keys this user has ALREADY been sent, on this channel.
 *
 * ⚠️ ONE STATEMENT, AND IT IS READ BEFORE DELIVERY RATHER THAN AFTER. The claim was previously
 * written after each send and never read, so it deduplicated nothing: duplicate emails were prevented
 * only by a KV watermark, and that fails open — kvSet checks neither the response status nor throws,
 * so a failed write leaves the watermark behind and the next run mails the same filings again.
 * Reading the claim first makes the database the guard, which cannot silently fail open.
 */
export async function alreadySent(userId, keys, channel) {
  const list = [...new Set((keys || []).filter(Boolean))];
  if (!list.length) return new Set();
  await ensureEvidenceAlertTables();
  const res = await db.execute(sql`
    select alert_key from evidence_alerts_sent
     where user_id = ${userId} and alert_key = any(${list.map((k) => channelKey(channel, insiderAccessionKey(k)))})`);
  return new Set((res.rows ?? res).map((r) => String(r.alert_key)));
}
