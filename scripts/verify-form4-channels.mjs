// FORM 4 DELIVERY CHANNEL SEMANTICS — the matrix, executed.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-form4-channels.mjs
//
// ⚠️ PRODUCTION SAFETY, STATED FIRST BECAUSE IT WAS A REAL PROBLEM LAST TIME. The Evidence Alert
// verification left disposable subscriptions in a table a production cron reads, and the cron fired
// while they were there. That cannot happen here, and not by luck: the Form 4 mailer builds its
// recipient list from the WATCHLIST, and these fixtures write only to evidence_alerts_sent under
// `test_f4_%` user ids that appear in no watchlist. A production run cannot select them, cannot email
// them, and cannot be affected by them. Nothing here calls sendEmail or the mailer route.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { claim, alreadySent, channelKey, insiderAccessionKey } from '../src/lib/evidence-alerts.js';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const U = (s) => `test_f4_${Date.now()}_${s}`;
const ACC = (n) => `0009999-26-${String(n).padStart(6, '0')}`;
const cleanup = () => sql`delete from evidence_alerts_sent where user_id like 'test_f4_%'`;
await cleanup();

const before = (await sql`select count(*)::int n from evidence_alerts_sent`)[0].n;

try {
  L('⚠️ 1 — EMAIL ONLY: first delivery, retry, concurrent');
  {
    const u = U('email'); const a = ACC(1);
    const ev = insiderAccessionKey(a);
    ok('nothing is recorded yet', (await alreadySent(u, [ev], 'email')).size === 0);
    ok('⚠️ the first email claim succeeds', (await claim(u, ev, { channel: 'email' })) === true);
    ok('⚠️ a retry does NOT claim again — no duplicate email',
      (await claim(u, ev, { channel: 'email' })) === false);
    ok('…and the guard now reports it as sent', (await alreadySent(u, [ev], 'email')).has(ev));

    // ⚠️ CONCURRENCY, ACTUALLY RACED. Ten simultaneous claims for one event: exactly one may win. This
    // is a property of the primary key and ON CONFLICT DO NOTHING, not of application logic — which is
    // the whole reason the guarantee lives in Postgres.
    const u2 = U('race'); const ev2 = insiderAccessionKey(ACC(2));
    const results = await Promise.all(Array.from({ length: 10 }, () => claim(u2, ev2, { channel: 'email' })));
    ok('⚠️ ten concurrent claims yield exactly one winner',
      results.filter(Boolean).length === 1, `${results.filter(Boolean).length} winners`);
    ok('…and exactly one row exists',
      (await sql`select count(*)::int n from evidence_alerts_sent where user_id=${u2}`)[0].n === 1);
  }

  L('⚠️ 2 — IN-APP ONLY: first delivery, retry, concurrent');
  {
    const u = U('inapp'); const ev = insiderAccessionKey(ACC(3));
    ok('⚠️ the first in-app claim succeeds', (await claim(u, ev, { channel: 'in_app' })) === true);
    ok('⚠️ a retry does NOT claim again — no duplicate notification',
      (await claim(u, ev, { channel: 'in_app' })) === false);
    ok('…and the in-app guard reports it', (await alreadySent(u, [ev], 'in_app')).has(ev));
    const u2 = U('inapprace'); const ev2 = insiderAccessionKey(ACC(4));
    const r = await Promise.all(Array.from({ length: 10 }, () => claim(u2, ev2, { channel: 'in_app' })));
    ok('⚠️ ten concurrent in-app claims yield exactly one winner', r.filter(Boolean).length === 1);
  }

  L('⚠️ 3 — BOTH CHANNELS: one each, and neither suppresses the other');
  {
    const u = U('both'); const a = ACC(5); const ev = insiderAccessionKey(a);
    ok('⚠️ email claims the event', (await claim(u, ev, { channel: 'email' })) === true);
    // ⚠️ THE CORE PRODUCT RULE. An existing email delivery must not make the in-app ineligible.
    ok('⚠️ …and in-app STILL claims the same event', (await claim(u, ev, { channel: 'in_app' })) === true);
    ok('⚠️ two rows exist for one filing — one per channel',
      (await sql`select count(*)::int n from evidence_alerts_sent where user_id=${u}`)[0].n === 2);
    ok('…each channel reports its own delivery',
      (await alreadySent(u, [ev], 'email')).has(ev) && (await alreadySent(u, [ev], 'in_app')).has(ev));
    ok('⚠️ and neither can be claimed a second time',
      (await claim(u, ev, { channel: 'email' })) === false
      && (await claim(u, ev, { channel: 'in_app' })) === false);

    // The reverse order must behave identically — in-app first must not block the email.
    const u2 = U('both2'); const ev2 = insiderAccessionKey(ACC(6));
    ok('⚠️ in-app first, then email: both succeed',
      (await claim(u2, ev2, { channel: 'in_app' })) === true
      && (await claim(u2, ev2, { channel: 'email' })) === true);
    // ⚠️ AND THE KEYS CANNOT COLLIDE BY CONSTRUCTION.
    ok('⚠️ an email key can never equal an in-app key',
      channelKey('email', ev2) !== channelKey('in_app', ev2));
    const stored = await sql`select alert_key, channel from evidence_alerts_sent where user_id=${u2} order by channel`;
    ok('…and the stored keys carry the channel', stored.map((s) => s.alert_key).join(' ') === `${channelKey('email', ev2)} ${channelKey('in_app', ev2)}`,
      JSON.stringify(stored));
  }

  L('⚠️ 4 — PARTIAL FAILURE: each channel recovers alone');
  {
    // ⚠️ THE SHAPE THE BRIEF ASKS FOR. The mailer claims only after a SUCCESSFUL send, so a failed
    // channel simply has no row — and its retry is a fresh claim, while the channel that already
    // succeeded stays claimed. An all-or-nothing key would make this impossible.
    const u = U('partialA'); const ev = insiderAccessionKey(ACC(7));
    await claim(u, ev, { channel: 'in_app' });            // in-app succeeded
    // email failed → never claimed
    ok('⚠️ A: in-app succeeded, email was never claimed', (await alreadySent(u, [ev], 'email')).size === 0);
    ok('⚠️ A: the retry can send ONLY the missing email', (await claim(u, ev, { channel: 'email' })) === true);
    ok('⚠️ A: …and does not re-create the in-app notification',
      (await claim(u, ev, { channel: 'in_app' })) === false);

    const u2 = U('partialB'); const ev2 = insiderAccessionKey(ACC(8));
    await claim(u2, ev2, { channel: 'email' });           // email succeeded
    ok('⚠️ B: email succeeded, in-app was never claimed', (await alreadySent(u2, [ev2], 'in_app')).size === 0);
    ok('⚠️ B: the retry can create ONLY the missing in-app', (await claim(u2, ev2, { channel: 'in_app' })) === true);
    ok('⚠️ B: …and does not send another email', (await claim(u2, ev2, { channel: 'email' })) === false);

    // ⚠️ AND THE MAILER'S ORDERING IS WHAT MAKES ANY OF THAT TRUE. Mutation testing found all three of
    // these uncovered: the primitives were asserted exhaustively while the sequencing around them —
    // which is where "a failed email is retried" actually lives — was only implied.
    const m = code('src/app/api/cron/insider-alerts/route.js');
    ok('⚠️ the guard is READ before the send, not after',
      m.indexOf('await alreadySent(') < m.indexOf('await sendEmail('));
    ok('⚠️ the claim is written AFTER the send, never before',
      m.indexOf('await sendEmail(') < m.indexOf('await claim('),
      'claiming first means a failed email is never retried and nobody is ever told');
    ok('⚠️ …and only when the send actually succeeded',
      /const ok = await sendEmail\([\s\S]{0,200}?if \(ok\) \{[\s\S]{0,400}?await claim\(/.test(m),
      'claiming a failed send silences the retry for a filing nobody received');
    ok('⚠️ an unreadable guard SKIPS the user rather than sending everything again',
      /\} catch \{[\s\S]{0,300}?skipped\+\+;\s*continue;\s*\}/.test(m)
      && !/\} catch \{\s*seen = new Set\(\);/.test(m));
  }

  L('⚠️ 5 — event identity: the accession, and separate filings stay separate');
  {
    const u = U('identity');
    const a1 = ACC(20), a2 = ACC(21);
    ok('⚠️ the identity is the SEC accession', insiderAccessionKey(a1) === `insider:${a1}`);
    ok('⚠️ two legitimate accessions remain separately eligible',
      (await claim(u, insiderAccessionKey(a1), { channel: 'email' })) === true
      && (await claim(u, insiderAccessionKey(a2), { channel: 'email' })) === true);
    ok('…as two rows', (await sql`select count(*)::int n from evidence_alerts_sent where user_id=${u}`)[0].n === 2);
    // ⚠️ THE SAME ACCESSION ENCOUNTERED AGAIN IS ONE EVENT, whatever else changed about the summary.
    ok('⚠️ the same accession again is not eligible', (await claim(u, insiderAccessionKey(a1), { channel: 'email' })) === false);
    // And the identity does NOT fall back to ticker/date/insider/subject.
    const m = code('src/app/api/cron/insider-alerts/route.js');
    ok('⚠️ the mailer keys on the accession, not the summary or the subject',
      /insiderAccessionKey\(f\.accession\)/.test(m) && !/insiderAccessionKey\(f\.ticker/.test(m));
    ok('…and a filing with no accession is never claimed', /if \(!f\.accession\) continue;/.test(m));
    ok('⚠️ …and retracted filings never alert at all', /superseded_by IS NULL/.test(m));
  }

  L('⚠️ 6 — the channel cannot be omitted, which is what made this structural');
  {
    const lib = code('src/lib/evidence-alerts.js');
    // ⚠️ THE DEFECT: channel scoping was a call-site convention. claim() stored whatever string it was
    // handed, so a caller could write a channel-less key — and the 12 historical rows are what that
    // looks like. It is now applied inside the primitive.
    ok('⚠️ claim applies the channel itself', /const stored = channelKey\(channel, eventKey\);/.test(lib));
    ok('⚠️ …and inserts the scoped key, not the raw one', /values \(\$\{userId\}, \$\{stored\}/.test(lib));
    ok('⚠️ alreadySent applies it too, symmetrically', /channelKey\(channel, k\)/.test(lib));
    ok('⚠️ …and returns EVENT keys, so the caller cannot rebuild a different one',
      /out\.add\(ev\)/.test(lib));
    // The mailer must no longer build storage keys by hand anywhere.
    const m = code('src/app/api/cron/insider-alerts/route.js');
    ok('⚠️ the mailer never builds a channel-scoped key itself', !/channelKey\(/.test(m));
    ok('…it names the channel once, as an argument', (m.match(/'email'/g) || []).length === 2,
      `${(m.match(/'email'/g) || []).length} occurrences`);
    ok('⚠️ the read, the filter and the write all use the event key',
      /alreadySent\(userId, all\.map\(\(f\) => \(f\.accession \? insiderAccessionKey\(f\.accession\) : null\)\), 'email'\)/.test(m)
      && /!seen\.has\(insiderAccessionKey\(f\.accession\)\)/.test(m)
      && /await claim\(userId, insiderAccessionKey\(f\.accession\)/.test(m));
  }

  L('⚠️ 7 — existing data: historical rows are preserved and cannot be collided with');
  {
    // ⚠️ REQUIREMENT: do not mass-delete history, do not cause old events to resend.
    const hist = await sql`select channel, count(*)::int n from evidence_alerts_sent
      where user_id not like 'test_f4_%' and alert_key not like 'email:%' and alert_key not like 'in_app:%'
      group by 1`;
    const histN = hist.reduce((a, r) => a + r.n, 0);
    ok('⚠️ the retired alerter\'s unprefixed rows are still there', histN > 0, `${histN} rows: ${JSON.stringify(hist)}`);
    // ⚠️ AND A NEW CLAIM FOR THE SAME FILING CANNOT COLLIDE WITH ONE, which was the latent trap: a
    // future in-app writer repeating the old mistake would have silently suppressed a notification.
    const sample = await sql`select user_id, alert_key from evidence_alerts_sent
      where alert_key not like 'email:%' and alert_key not like 'in_app:%' limit 1`;
    if (sample.length) {
      const legacyKey = String(sample[0].alert_key);
      ok('⚠️ a channel-scoped claim for the same event is a DIFFERENT key',
        channelKey('in_app', legacyKey) !== legacyKey && channelKey('email', legacyKey) !== legacyKey);
      console.log(`         legacy key "${legacyKey}" vs scoped "${channelKey('in_app', legacyKey)}"`);
    }
    // ⚠️ THE EMAIL LEDGER HAS NEVER BEEN WRITTEN, which is why this change needs no migration: there is
    // no stored email key whose shape could change and cause a resend.
    const emails = await sql`select count(*)::int n from evidence_alerts_sent
      where alert_key like 'email:%' and user_id not like 'test_f4_%'`;
    ok('⚠️ no production email claim exists, so no filing can be re-sent by this change',
      emails[0].n === 0, `${emails[0].n} email rows`);
    ok('…and the stored shape is unchanged anyway', channelKey('email', insiderAccessionKey('X')) === 'email:insider:X');
  }

  L('⚠️ 8 — entitlement and channel preference: what the product actually does');
  {
    const m = code('src/app/api/cron/insider-alerts/route.js');
    // ⚠️ DOCUMENTED, NOT CHANGED. Form 4 email is driven by the WATCHLIST and is not Pro-gated — it is
    // available to Free. Adding a Pro gate here would remove a working feature from Free users, which is
    // not this task. What is pinned is the fact, so the next reader does not have to re-derive it.
    ok('⚠️ recipients come from the watchlist', /from\(watchlist\)/.test(m));
    ok('⚠️ …and the mailer applies no tier gate (Form 4 email is a Free feature)',
      !/resolveUserAccess|isProTier|PRO_TIERS/.test(m));
    ok('…so no independent channel-preference store exists to respect',
      !/email_alerts|notify_email|alert_email|channel_pref/.test(m));
    // ⚠️ AND THE EVIDENCE ALERT ENTITLEMENT WE JUST ESTABLISHED IS UNTOUCHED.
    const w = code('src/lib/alerts/evidence-alert-worker.mjs');
    ok('⚠️ the Evidence Alert worker still checks entitlement at delivery',
      /const subs = allSubs\.filter\(\(s\) => PRO_TIERS\.has\(access\.get\(s\.userId\)\?\.tier\)\)/.test(w));
    ok('…and still uses the shared resolver', /resolveAccess = resolveAccessByIds,/.test(w));
    // ⚠️ AND THE TWO SYSTEMS REMAIN SEPARATE LEDGERS. The bell dedupes in evidence_alerts on
    // (user_id, evidence_id); the mailer in evidence_alerts_sent. Neither reads the other.
    ok('⚠️ the Evidence Alert worker never reads the email ledger',
      !/evidence_alerts_sent|alreadySent/.test(w));
    ok('…and the email mailer never reads the bell\'s table',
      !/evidence_alert_subs|insertAlerts/.test(m));
  }
} finally {
  await cleanup();
  const left = (await sql`select count(*)::int n from evidence_alerts_sent where user_id like 'test_f4_%'`)[0].n;
  const after = (await sql`select count(*)::int n from evidence_alerts_sent`)[0].n;
  console.log(`\n(cleanup: ${left} test rows remaining · table ${before} → ${after} rows, historical data intact)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
