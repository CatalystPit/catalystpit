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
 * ⚠️ THE CHANNEL IS APPLIED IN HERE, NOT BY THE CALLER — AND THAT IS THE FIX.
 *
 * Channel scoping was already correct in effect, but only as a CONVENTION at the one call site: the
 * mailer passed `channelKey('email', insiderAccessionKey(acc))` and `claim` stored whatever string it
 * was handed. Two things followed from that.
 *
 * ⚠️ FIRST, A CALLER COULD OMIT THE CHANNEL, AND ONE DID. `evidence_alerts_sent` still holds 12 rows
 * written by the retired watchlist-driven alerter whose keys are UNPREFIXED — `insider:0001921094-26-001050`
 * — with the channel recorded only in the column. Those are exactly what a channel-less key looks like,
 * and the moment an in-app Form 4 channel is added, a caller repeating that mistake would write
 * `insider:<acc>`, collide with a nine-month-old row, and silently suppress a notification. The
 * historical rows are deliberately left alone (they are the in-app channel's real dedupe history); what
 * changes is that a new one cannot be written, because the channel is no longer optional.
 *
 * ⚠️ SECOND, THE READ AND THE WRITE SPOKE DIFFERENT LANGUAGES. alreadySent took a raw ACCESSION and
 * applied both prefixes itself; claim took a fully-built STORAGE KEY and applied neither. A caller that
 * got that asymmetry wrong would read one key and write another — the read would never find the write,
 * and the same filing would be emailed on every single run, forever. That is the worst failure this
 * table exists to prevent, and nothing structural stopped it.
 *
 * Both now take the same thing: an EVENT KEY (`insider:<accession>`), with the channel as an argument.
 * The stored string is byte-identical to before — `email:insider:<accession>` — so there is no
 * migration, no key rewrite, and no possibility of an already-emailed filing being sent again.
 *
 * The INSERT is the claim. The caller claims only after a successful delivery, so a crash between the
 * two loses one delivery rather than repeating it forever, which is the safer side of that trade for
 * something that interrupts a person.
 *
 * @param eventKey the channel-independent identity of the event, e.g. insiderAccessionKey(accession)
 * @returns true exactly once per (user, event, channel), ever.
 */
export async function claim(userId, eventKey, { ticker = null, family = null, channel = 'in_app' } = {}) {
  await ensureEvidenceAlertTables();
  const stored = channelKey(channel, eventKey);
  const res = await db.execute(sql`
    insert into evidence_alerts_sent (user_id, alert_key, ticker, family, channel)
    values (${userId}, ${stored}, ${ticker}, ${family}, ${channel})
    on conflict (user_id, alert_key) do nothing
    returning alert_key`);
  return (res.rows ?? res).length > 0;
}

/**
 * Which of these EVENT KEYS this user has already been delivered, on this channel.
 *
 * ⚠️ ONE STATEMENT, AND IT IS READ BEFORE DELIVERY RATHER THAN AFTER. The claim was previously
 * written after each send and never read, so it deduplicated nothing: duplicate emails were prevented
 * only by a KV watermark, and that fails open — kvSet checks neither the response status nor throws,
 * so a failed write leaves the watermark behind and the next run mails the same filings again.
 * Reading the claim first makes the database the guard, which cannot silently fail open.
 *
 * ⚠️ IT RETURNS EVENT KEYS, NOT STORAGE KEYS. It used to return the raw `alert_key` strings, so the
 * caller had to rebuild `channelKey('email', insiderAccessionKey(acc))` to test membership — the same
 * asymmetry described on claim, in the one place where getting it wrong means mailing every filing on
 * every run. The caller now asks with event keys and tests with event keys; the channel appears once,
 * as an argument.
 */
export async function alreadySent(userId, eventKeys, channel) {
  const list = [...new Set((eventKeys || []).filter(Boolean))];
  if (!list.length) return new Set();
  await ensureEvidenceAlertTables();
  // ⚠️ AN EXPANDED IN-LIST, NOT `= any($n)`. The first version passed the JS array as a single bound
  // parameter, which Neon serialises as a plain string — Postgres answered `malformed array literal:
  // "email:insider:0009999-26-000001"` and the whole statement threw. That mattered far more than a
  // failed query: the mailer treats an unreadable ledger as a reason to SKIP the user, so every
  // recipient would have been skipped and no insider email would ever have been sent. Caught by
  // running the function rather than grepping for it.
  const byStored = new Map(list.map((k) => [channelKey(channel, k), k]));
  const res = await db.execute(sql`
    select alert_key from evidence_alerts_sent
     where user_id = ${userId}
       and alert_key in (${sql.join([...byStored.keys()].map((k) => sql`${k}`), sql`, `)})`);
  const out = new Set();
  for (const r of (res.rows ?? res)) {
    const ev = byStored.get(String(r.alert_key));
    if (ev) out.add(ev);
  }
  return out;
}
