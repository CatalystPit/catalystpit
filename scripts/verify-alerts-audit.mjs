// ALERTS / NOTIFICATIONS — the invariants the final audit established, and the defects it found.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-alerts-audit.mjs
//
// ⚠️ SCOPE. verify-evidence-alerts.mjs already covers the significance rules, the clock and the
// idempotence key. This file adds what the final audit checked that it did not: the failure contract
// on every alert-facing route, the "delivered before disarmed" ordering in the rule engine, and the
// fact that three separate alert engines exist of which exactly one is live.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// ⚠️ COMMENTS STRIPPED. This codebase documents each fix directly above it and QUOTES the line it
// replaced, so a search for a removed shape finds the comment explaining its removal.
const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '');
const one = async (q) => (await q)[0];

L('⚠️ an outage is never served as "nothing has happened"');
{
  // ⚠️ THE DEFECT CLASS, FOUND ON FOUR ROUTES. Each catch returned a 200 with an empty payload, so a
  // failed query became an authoritative claim: no subscriptions, no alerts, nothing unread, no
  // rules. On a notification system that is the one lie the user cannot detect.
  const ROUTES = [
    ['src/app/api/evidence-alerts/route.js', 'subscriptions', 'alerts_unavailable', /\{ pro: false, tickers: \[\], error/],
    ['src/app/api/evidence-alerts/inbox/route.js', 'the alert inbox', 'inbox_unavailable', /\{ alerts: \[\], unread: 0, error/],
    ['src/app/api/notifications/route.js', 'the notification bell', 'notifications_unavailable', /\{ notifications: \[\], unread: 0, loggedIn: !!userId, error/],
    ['src/app/api/alerts/route.js', 'the alert rules', 'alerts_unavailable', /\{ alerts: \[\], types: CREATABLE_ALERT_TYPES, error/],
  ];
  for (const [f, label, code_, oldShape] of ROUTES) {
    const c = code(f);
    ok(`⚠️ ${label}: a failed read answers 503, not 200`, /status: 503/.test(c));
    ok(`⚠️ ${label}: no longer returns an empty payload on failure`, !oldShape.test(c), String(oldShape).slice(0, 50));
    ok(`${label}: the failure carries an opaque code`, new RegExp(`error: '${code_}'`).test(c));
    // ⚠️ SCOPED TO THE RETURNS, because these files name e.message in the log line on purpose.
    const returns = (c.match(/return Response\.json\([\s\S]*?\);/g) || []).join(' ');
    ok(`⚠️ ${label}: never hands the caller the exception text`, !/e\.message|e\?\.message/.test(returns),
      (returns.match(/[^;]*message[^;]*/) || [''])[0].slice(0, 70));
    ok(`${label}: every response is private`, /private, no-store/.test(c));
  }
  // The bell's own consumer must leave its state alone on a non-ok response, or the 503 achieves
  // nothing — it would swap a false zero for a blank panel.
  const bell = code('src/lib/cp-shared.jsx');
  ok('⚠️ the bell applies only a truthy body, so a 503 keeps the last known count',
    /const j = r\.ok \? await r\.json\(\) : null;\s*\n?\s*if \(j\) \{ setList/.test(bell)
    || /if \(j\) \{ setList\(j\.notifications/.test(bell));
  ok('…and the same for the evidence half', /if \(j\) \{ setAlerts\(j\.alerts/.test(bell));
  // The subscription client must fail CLOSED, not open.
  const subs = code('src/lib/alerts/alert-subs-client.js');
  ok('⚠️ an unconfirmed subscription reads as OFF, never as ON',
    /if \(!r\.ok\) return \{ pro: false, tickers: new Set\(\) \}/.test(subs));
  // The Terminal panel said "No alerts yet" on a failed load.
  const term = code('src/app/terminal/TerminalClient.jsx');
  ok('⚠️ the Terminal alert panel distinguishes a failed load from an empty list',
    /if \(!r\.ok\) throw new Error\(String\(r\.status\)\);/.test(term) && /\.catch\(\(\) => setFailed\(true\)\)/.test(term));
  ok('…and says the rules are still armed rather than that none exist',
    /Any rules you set are still armed/.test(read('src/app/terminal/TerminalClient.jsx')));
  ok('…with the failure branch before the "No alerts yet" claim',
    term.indexOf('Could not load your alerts') < term.indexOf('No alerts yet'));
}

L('⚠️ a refusal the user can act on is not the same as our failure');
{
  const ue = code('src/lib/user-error.mjs');
  ok('the marker exists and defaults to opaque', /status: 503/.test(ue) && /isUserError\(e\)/.test(ue));
  const { userError, isUserError, errorResponse } = await import('../src/lib/user-error.mjs');
  ok('a marked refusal keeps its message at 400', errorResponse(userError('limit of 200 alerts reached'), 'x').status === 400
    && errorResponse(userError('limit of 200 alerts reached'), 'x').body.error === 'limit of 200 alerts reached');
  // ⚠️ THE DEFAULT IS THE POINT: an unmarked throw is OURS, and must not be echoed.
  ok('⚠️ an unmarked throw becomes an opaque 503', errorResponse(new Error('relation "alerts" does not exist'), 'alerts_unavailable').status === 503);
  ok('…and its message does not reach the body',
    errorResponse(new Error('relation "alerts" does not exist'), 'alerts_unavailable').body.error === 'alerts_unavailable');
  ok('a raw Error is not mistaken for a refusal', isUserError(new Error('x')) === false);
  // Every validation throw a user is meant to read is marked.
  for (const f of ['src/lib/alerts.js', 'src/lib/alerts/evidence-alert-store.js']) {
    const c = code(f);
    const unmarked = (c.match(/throw new Error\([^)]*\)/g) || []);
    ok(`${f}: no validation throw is left unmarked`, unmarked.length === 0, unmarked.join(' | '));
  }
}

L('⚠️ an alert is disarmed only if it was actually delivered');
{
  const c = code('src/lib/alerts.js');
  // ⚠️ THE DEFECT: the notify insert was wrapped in try/catch and execution fell through to the
  // disarm, so a failed write CONSUMED a one-shot rule. The user saw "TRIGGERED · re-arm" for a
  // notification that was never written.
  ok('⚠️ a failed notification returns before the disarm', /return false;\s*\n\s*\}\s*\n\s*await db\.update\(alerts\)\.set\(\{ active: false/.test(c),
    'the early return must sit between the catch and the update');
  ok('…and fire() reports whether it delivered', /^\s*return true;/m.test(c));
  ok('⚠️ the scan case does not advance `seen` on a failed notification',
    /'seen' NOT advanced/.test(read('src/lib/alerts.js')));
  ok('⚠️ the fired counter counts deliveries, not triggers', /if \(msg && await fire\(a, msg\)\) fired\+\+;/.test(c));
  ok('…for the scan case too', /if \(await fireScan\(a, msg, cfg\.filters, current\)\) fired\+\+;/.test(c));
  // And nothing may fire from absent data.
  ok('a rule cannot fire on a null quote', /q\?\.price != null && q\.price >= a\.threshold/.test(c));
  ok('⚠️ every upstream source degrades to empty rather than throwing into the loop',
    /getQuotes\(\[\.\.\.quoteSyms\], \{ realtime: false \}\)\.catch\(\(\) => \(\{\}\)\)/.test(c));
  // A rule the engine cannot fire must not be offerable.
  ok('⚠️ the picker is served the CREATABLE set only', /types: CREATABLE_ALERT_TYPES/.test(code('src/app/api/alerts/route.js')));
  ok('…and rvol/volume stay non-creatable while volume is unlicensed',
    /key: 'rvol_above',[^}]*creatable: false/.test(c) && /key: 'volume_above',[^}]*creatable: false/.test(c));
}

L('⚠️ one person cannot touch another person\'s alerts');
{
  // ⚠️ IDs ARE GUESSABLE INTEGERS, so the owner predicate in the STATEMENT is the whole control.
  const a = code('src/lib/alerts.js');
  ok('delete is scoped to the owner in the statement',
    /db\.delete\(alerts\)\.where\(and\(eq\(alerts\.userId, userId\), eq\(alerts\.id, id\)\)\)/.test(a));
  ok('re-arm is scoped to the owner in the statement',
    /\.where\(and\(eq\(alerts\.userId, userId\), eq\(alerts\.id, id\)\)\)/.test(a));
  const s = code('src/lib/alerts/evidence-alert-store.js');
  // ⚠️ READ FROM markRead's OWN BODY. A file-wide regex passes on a sibling function's predicate —
  // that exact weakness was found in the watchlist audit.
  const markRead = s.slice(s.indexOf('export async function markRead'));
  ok('⚠️ marking one alert read is scoped to the owner, in markRead itself',
    /where user_id = \$\{userId\} and id = \$\{n\}/.test(markRead));
  ok('…and marking all read likewise', /where user_id = \$\{userId\} and not read/.test(markRead));
  ok('a non-numeric id is refused rather than coerced', /if \(!Number\.isFinite\(n\)\) return false;/.test(markRead));
  ok('every alert route resolves the user server-side, never from the body',
    ['src/app/api/alerts/route.js', 'src/app/api/notifications/route.js',
      'src/app/api/evidence-alerts/route.js', 'src/app/api/evidence-alerts/inbox/route.js']
      .every((f) => /await auth\(\)/.test(code(f))));
  // Entitlement, server-side, failing closed.
  const ea = code('src/app/api/evidence-alerts/route.js');
  ok('⚠️ creating a subscription is gated server-side', /async function requirePro\(\)/.test(ea) && /status: 403/.test(ea));
  ok('⚠️ …and an entitlement lookup failure denies rather than grants',
    /catch \{ tier = 'free'; \}/.test(ea));
  ok('reading the inbox is deliberately NOT tier-gated', /NO ENTITLEMENT GATE ON READING/.test(read('src/app/api/evidence-alerts/inbox/route.js')));
}

L('⚠️ the watermark cannot be widened, and a backfill cannot manufacture an alert');
{
  const w = code('src/lib/alerts/evidence-alert-worker.mjs');
  ok('⚠️ the effective watermark is the LATER of subscription and floor',
    /Math\.max\(subSince, Date\.parse\(floor\)\)/.test(w));
  ok('an unreadable watermark delivers nothing', /if \(!Number\.isFinite\(subSince\)\) continue;/.test(w));
  ok('⚠️ a resolution failure creates nothing', /failed\+\+;\s*\n\s*continue;/.test(w));
  ok('a prefetch failure skips the chunk rather than falling back to N+1', /failed \+= group\.length;/.test(w));
  const r = code('src/lib/alerts/evidence-alerts.mjs');
  ok('⚠️ timing runs through changedSince, which reads publicTime only', /changedSince\(Array\.isArray\(evidence\)/.test(r));
  ok('…and a row with an unparseable publicTime is dropped', /if \(!Number\.isFinite\(pub\)\) return null;/.test(r));
  ok('…and one with no engine id is dropped rather than risking a duplicate', /if \(!evidenceId\) return null;/.test(r));
  ok('market is not alertable', !/FAMILY\.MARKET/.test(r));
  // Re-enabling must not replay a backlog.
  const st = code('src/lib/alerts/evidence-alert-store.js');
  ok('⚠️ enabled_at moves only on an off→on transition',
    /case when excluded\.enabled and not evidence_alert_subs\.enabled/.test(st));
  ok('⚠️ delivery is idempotent in the database, not in the worker',
    /on conflict \(user_id, evidence_id\) do nothing/.test(st));
  ok('…backed by a unique index', /uq_evidence_alert\s*\n?\s*ON evidence_alerts \(user_id, evidence_id\)/.test(st));
  ok('unread alerts are retained longer than read ones', /not read and created_at < now\(\) - make_interval\(days => \$\{UNREAD_RETENTION_DAYS\}\)/.test(st));

  // Production: measured, not trusted.
  const f = await one(sql`select count(*)::int n from evidence_alerts where public_time > now() + interval '1 hour'`);
  ok('⚠️ no delivered alert is dated in the future', f.n === 0, `${f.n}`);
  const leak = await one(sql`select count(*)::int n from evidence_alerts a join evidence_alert_subs s
    on s.user_id = a.user_id and s.ticker = a.ticker
    where a.public_time < s.enabled_at - interval '1 minute'`);
  ok('⚠️ no alert predates its own subscriber watermark', leak.n === 0, `${leak.n}`);
  const dup = await one(sql`select count(*)::int n from
    (select user_id, evidence_id from evidence_alerts group by 1,2 having count(*) > 1) q`);
  ok('no duplicate (user, evidence) alert exists', dup.n === 0, `${dup.n}`);
  const fam = await sql`select distinct family from evidence_alerts`;
  ok('every delivered alert is in an alertable family',
    fam.every((x) => ['catalyst', 'insider', 'institution', 'congress'].includes(x.family)),
    fam.map((x) => x.family).join(','));
}

L('⚠️ exactly one alert engine is live, and the heartbeat says which');
{
  // ⚠️ THREE ENGINES EXIST. Two export a function called runEvidenceAlerts. This asserts which one
  // the cron actually runs, because importing the other would restore watchlist-driven,
  // non-Pro-gated alerting without any visible change at the call site.
  const cron = code('src/app/api/cron/evidence-alerts/route.js');
  ok('⚠️ the cron runs the subscription worker, not the watchlist module',
    /from '\.\.\/\.\.\/\.\.\/\.\.\/lib\/alerts\/evidence-alert-worker\.mjs'/.test(cron));
  ok('…and the orphaned module says so at the top of itself',
    /⚠️ ORPHANED\. runEvidenceAlerts\(\) BELOW IS NO LONGER CALLED BY ANYTHING\./.test(read('src/lib/evidence-alerts.js')));
  ok('…and records the 13F policy disagreement rather than silently differing',
    /13F IS NOT AN ALERT/.test(read('src/lib/evidence-alert-rules.mjs'))
    && /The LIVE path disagrees/.test(read('src/lib/evidence-alerts.js')));
  ok('⚠️ the stale email/bell suppression guarantee is corrected, not left asserting',
    /THIS CLAIM NO LONGER SUPPRESSES ANYTHING/.test(read('src/app/api/cron/insider-alerts/route.js')));
  // The heartbeat note must be readable on the path production actually takes.
  ok('⚠️ the zero-subscription return carries the full shape, so the note has no "undefined"',
    /failed: 0, pruned: 0, ms: Date\.now\(\) - startedAt/.test(code('src/lib/alerts/evidence-alert-worker.mjs')));
  ok('the mailer never alerts on a retracted filing',
    /insider_trades\.superseded_by IS NULL/.test(code('src/app/api/cron/insider-alerts/route.js')));
  ok('…and claims a filing only on a successful send', /if \(ok\) \{/.test(code('src/app/api/cron/insider-alerts/route.js')));
  ok('the mailer refuses to run unconfigured rather than pretending to', /error: 'not_configured'/.test(code('src/app/api/cron/insider-alerts/route.js')));
  ok('…and does not blast a backlog on its first run', /initialized watermark, no backlog sent/.test(read('src/app/api/cron/insider-alerts/route.js')));

  // Every alert cron requires authorization.
  for (const f of ['src/app/api/cron/alerts/route.js', 'src/app/api/cron/evidence-alerts/route.js', 'src/app/api/cron/insider-alerts/route.js']) {
    ok(`${f} refuses an unauthenticated caller`, /status: 401/.test(code(f)));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
