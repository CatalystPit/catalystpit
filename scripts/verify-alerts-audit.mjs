// ALERTS / NOTIFICATIONS — the invariants the final audit established, and the defects it found.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-alerts-audit.mjs
//
// ⚠️ SCOPE. verify-evidence-alerts.mjs already covers the significance rules, the clock and the
// idempotence key. This file adds what the final audit checked that it did not: the failure contract
// on every alert-facing route, the "delivered before disarmed" ordering in the rule engine, and the
// fact that three separate alert engines exist of which exactly one is live.
import { readFileSync, existsSync } from 'node:fs';
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
  // Matched without the trailing brace, so adding a field to the same object cannot fail an assertion
  // about denial — a `ready` flag was added to it and did exactly that.
  ok('⚠️ an unconfirmed subscription reads as OFF, never as ON',
    /if \(!r\.ok\) return \{ pro: false, tickers: new Set\(\)/.test(subs));
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
  // ⚠️ THE SECOND ENGINE IS GONE, not annotated. It exported a same-named runEvidenceAlerts, so an
  // import of the wrong one would have silently restored watchlist-driven, non-Pro-gated alerting.
  ok('⚠️ the orphaned watchlist-driven engine no longer exists',
    !/export async function runEvidenceAlerts/.test(read('src/lib/evidence-alerts.js')));
  ok('…and only one runEvidenceAlerts is defined in the codebase',
    (['src/lib/evidence-alerts.js', 'src/lib/alerts/evidence-alert-worker.mjs']
      .map((f) => read(f)).join('\n').match(/export async function runEvidenceAlerts/g) || []).length === 1);
  ok('…and what remains is described as the email ledger', /THE EMAIL CHANNEL'S DELIVERY LEDGER/.test(read('src/lib/evidence-alerts.js')));

  // ⚠️ ONE POLICY ON 13F, NOT TWO. The deleted module declared "13F IS NOT AN ALERT" while the live
  // path includes FAMILY.INSTITUTION. The owner's rule is that institutional activity CAN alert when
  // it qualifies, so the dead policy was removed rather than reconciled.
  ok('⚠️ the contradicting rules module is deleted', !existsSync(new URL('../src/lib/evidence-alert-rules.mjs', import.meta.url)));
  // ⚠️ IMPORT STATEMENTS ONLY. The surviving file NAMES the deleted module in the comment that
  // explains why it was deleted, so a file-wide search finds the explanation rather than a dependency.
  ok('…nothing imports it any more', !/from '\.[^']*evidence-alert-rules[^']*'/.test(
    ['src/lib/evidence-alerts.js', 'src/lib/alerts/evidence-alerts.mjs', 'src/lib/alerts/evidence-alert-worker.mjs']
      .map((f) => code(f)).join('\n')));
  ok('⚠️ exactly one ALERTABLE_FAMILIES exists, and institution is in it',
    /FAMILY\.CATALYST, FAMILY\.INSIDER, FAMILY\.INSTITUTION, FAMILY\.CONGRESS/.test(read('src/lib/alerts/evidence-alerts.mjs')));
  {
    const { ALERTABLE_FAMILIES } = await import('../src/lib/alerts/evidence-alerts.mjs');
    ok('…and the live module actually exports it that way', ALERTABLE_FAMILIES.includes('institution'), ALERTABLE_FAMILIES.join(','));
    ok('…and market is still excluded, which is the only deliberate exclusion', !ALERTABLE_FAMILIES.includes('market'));
  }
  // ⚠️ AND IT IS NOT ONE ALERT PER 13F ROW. The engine emits ONE aggregate per quarter per ticker,
  // judged against that ticker's own breadth history, so admitting the family is not a firehose.
  ok('⚠️ institution evidence is an aggregate per quarter, not a row per filing',
    /type: 'institution_breadth_change'/.test(read('src/lib/evidence/resolve.js')));
  ok('…compared against this ticker\'s own history', /is meaningless until you/.test(read('src/lib/evidence/resolve.js')));
  ok('…and an implausible breadth change is refused rather than alerted',
    /implausibleBreadth\(prev\.breadth, latest\.breadth\)/.test(read('src/lib/evidence/resolve.js')));

  // ⚠️ THE CHANNELS ARE INDEPENDENT BY CONSTRUCTION, not by comment.
  const mailer = code('src/app/api/cron/insider-alerts/route.js');
  // ⚠️ THE CHANNEL MOVED INSIDE THE PRIMITIVES, so the mailer no longer builds a scoped key: it asks and
  // writes with the EVENT key and names the channel once, as an argument. The last assertion is the one
  // that matters most — a caller that can still hand-build a storage key can still read one and write
  // another, which is how a filing gets emailed on every run forever.
  ok('⚠️ the email channel dedupes by READING its ledger before sending',
    /await alreadySent\(userId, all\.map\(\(f\) => \(f\.accession \? insiderAccessionKey\(f\.accession\) : null\)\), 'email'\)/.test(mailer));
  ok('…and it filters on the same event key it asked with',
    /!seen\.has\(insiderAccessionKey\(f\.accession\)\)/.test(mailer));
  ok('⚠️ …and the mailer never builds a channel-scoped key itself', !/channelKey\(/.test(mailer));
  ok('…so an email key can never equal an in-app key', /export const channelKey = \(channel, key\) => `\$\{channel\}:\$\{key\}`;/.test(read('src/lib/evidence-alerts.js')));
  ok('⚠️ an unreadable ledger skips the user rather than sending twice',
    /skipped\+\+;\s*\n\s*continue;/.test(mailer));
  ok('…and a filing already emailed is dropped, counted, not re-sent', /if \(!items\.length\) \{ deduped\+\+; continue; \}/.test(mailer));
  ok('…while the claim is still written only on a successful send', /if \(ok\) \{/.test(mailer));
  ok('the bell keeps its own independent dedupe in its own table',
    /on conflict \(user_id, evidence_id\) do nothing/.test(read('src/lib/alerts/evidence-alert-store.js')));
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

L('the alert control tells the truth rather than hiding');
{
  const t = code('src/components/AlertToggle.jsx');
  // ⚠️ HIDING A CONTROL IS NOT ENTITLEMENT, and showing "Alert On" for a refused subscription is
  // worse than either — it tells someone they are covered when they are not.
  ok('the control is rendered for everyone and refuses at the server', !/if \(!pro\) return null/.test(t));
  ok('⚠️ a refusal does not move the control', /THE CONTROL DOES NOT MOVE ON A REFUSAL/.test(read('src/components/AlertToggle.jsx')));
  ok('…and the reason is surfaced to the user', /onNotice\?\.\(err\.message\)/.test(t));
  ok('the server\'s answer is what lands in the set, not the optimistic guess',
    /new Set\(j\.tickers \|\| \[\]\)/.test(code('src/lib/alerts/alert-subs-client.js')));

  // The one alert channel that leaves our origin. SEC-derived text is interpolated into HTML.
  const mail = code('src/app/api/cron/insider-alerts/route.js');
  for (const f of ['f.ticker', 'f.executive', 'f.filingDate']) {
    ok(`⚠️ the email escapes ${f} before it reaches HTML`, new RegExp(`esc\\(${f.replace('.', '\\.')}`).test(mail));
  }
  ok('…and the ticker is encoded, not interpolated, into the link', /encodeURIComponent\(f\.ticker\)/.test(mail));
  ok('the email says why it was received and how to stop it', /on your CatalystPit watchlist/.test(read('src/app/api/cron/insider-alerts/route.js')));
}

L('⚠️ a public heartbeat note is never an error dump');
{
  // ⚠️ FOUND WHILE VERIFYING THE ALERT CRONS' HEARTBEATS. /api/health is unauthenticated and serves
  // every job's note. The dividends job's note in production was a dumped INSERT statement —
  // "Failed query: insert into dividend_events (source, source_event_id, ticker, cik, ..." — so a
  // public endpoint was publishing our table and column names, because one caller passed e.message
  // where every other caller passes a fixed string.
  const hb = code('src/lib/job-heartbeat.js');
  ok('the note is sanitised at the WRITE, so no caller can leak through it', /\$\{safeNote\(note\)\}/.test(hb));
  ok('…and the contract it enforces is stated', /never an error dump/.test(read('src/lib/job-heartbeat.js')));
  const { safeNote } = await import('../src/lib/job-heartbeat.js');
  ok('⚠️ a dumped query is replaced, not truncated',
    safeNote('Failed query: \n  insert into dividend_events (\n source, ticker') === 'query failed — detail in logs');
  ok('⚠️ a relation-missing error is replaced', safeNote('relation "evidence_alerts" does not exist') === 'query failed — detail in logs');
  // ⚠️ AND EVERY REAL NOTE SURVIVES. A sanitiser that ate the legitimate notes would blind the
  // health check it exists to protect, so these are the exact strings production writes.
  for (const n of ['no watchers matched', 'checked 2', 'chambers both', 'all keys refreshed',
    '83 rows / 3324 candidates in 60s', 'scanned 297 8-K, 10 form-25, 105 form-144, 37 sched-13d in 6s',
    '0 tickers · 0 subs · 0 new · 0 failed · 12ms', 'ingest threw', 'watermark initialised']) {
    ok(`a real note passes through untouched: "${n.slice(0, 34)}"`, safeNote(n) === n, JSON.stringify(safeNote(n)));
  }
  ok('an empty note stays null rather than becoming a blank string', safeNote('  ') === null && safeNote(null) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
