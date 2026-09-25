// EVIDENCE ALERTS V1 — the behaviour, not the plumbing.
//
// An alerting feature has exactly two ways to destroy its own credibility, and both are silent:
//
//   1. IT TELLS YOU ABOUT SOMETHING THAT WAS ALREADY PUBLIC. You subscribe at noon and immediately
//      receive a 13F "alert" about a quarter that ended in June. Every backtest built on that
//      product is unreproducible, and the trader cannot tell by looking.
//   2. IT TELLS YOU THE SAME THING FOUR TIMES. One press release reaches us as a press release, a
//      wire item, an SEC filing and a Consensus input. Four bells for one event trains the reader
//      to ignore the bell.
//
// Everything below exists to hold those two shut, plus the entitlement boundary and the promise
// that no surface asks the server one question per ticker.
//
// Run: node scripts/verify-evidence-alerts.mjs

import { readFileSync } from 'node:fs';
import {
  ALERTABLE_FAMILIES, FAMILY_LABEL, LOOKBACK_DAYS, RETENTION_DAYS, UNREAD_RETENTION_DAYS,
  toAlert, alertsFor,
} from '../src/lib/alerts/evidence-alerts.mjs';
import { FAMILY, makeEvidence, FUTURE_TOLERANCE_MS } from '../src/lib/evidence/model.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

const NOW = Date.parse('2026-09-25T16:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

/** A real evidence object, built through the engine's own constructor so it is valid by its rules. */
const ev = (over = {}) => {
  const r = makeEvidence({
    ticker: 'MSTR', family: FAMILY.CATALYST, type: 'sec_8k_other', source: 'sec_8k', sourceId: '0001-26-000001',
    publicTime: hoursAgo(1), summary: 'Other material event', url: 'https://sec.gov/x',
    ...over,
  }, { now: NOW });
  return r.ok ? r.evidence : null;
};

L('⚠️ WHAT MAY BECOME AN ALERT — THE ENGINE DECIDES, NOT THIS LAYER');
{
  ok('the four evidence families are alertable',
    [FAMILY.CATALYST, FAMILY.INSIDER, FAMILY.INSTITUTION, FAMILY.CONGRESS].every((f) => ALERTABLE_FAMILIES.includes(f)));
  // ⚠️ MARKET IS THE ONE EXCLUSION, AND THE ENGINE ALREADY SAYS WHY: it is CONTEXT, it "never
  // creates evidence". Alerting on it would be a price alert in an evidence costume.
  ok('⚠️ the market family is NOT alertable — a price move is not a public disclosure',
    !ALERTABLE_FAMILIES.includes(FAMILY.MARKET)
    && toAlert({ ...ev(), family: FAMILY.MARKET }) === null);
  ok('…and it is the only exclusion, so no family is quietly dropped',
    ALERTABLE_FAMILIES.length === Object.values(FAMILY).length - 1);

  // ⚠️ NO SECOND MATERIALITY RULE. If this file filtered on materiality or direction it would be a
  // second evidence methodology, which is the thing the brief forbids most explicitly.
  const src = code(read('../src/lib/alerts/evidence-alerts.mjs'));
  ok('⚠️ nothing here scores, ranks or re-judges materiality',
    !/materiality|score|rank|weight|threshold|bullish|bearish|conviction/i.test(src));
  ok('⚠️ …and the point-in-time filter is the engine\'s own changedSince, not a reimplementation',
    /changedSince\(/.test(src) && !/publicTime\s*>\s*(?!=)/.test(src.replace(/changedSince[\s\S]{0,80}/g, '')));

  ok('every word shown comes from the engine',
    toAlert(ev()).detail === 'Other material event' && toAlert(ev()).title === FAMILY_LABEL[FAMILY.CATALYST]);
  ok('…and the family name characterises nothing',
    !/good|bad|strong|weak|bullish|bearish|buy|sell signal/i.test(Object.values(FAMILY_LABEL).join(' ')));
}

L('⚠️ POINT-IN-TIME: NEVER AN ALERT FOR SOMETHING ALREADY PUBLIC');
{
  const subscribedAt = hoursAgo(2);
  const older = ev({ publicTime: hoursAgo(5), summary: 'Already public' });
  const newer = ev({ publicTime: hoursAgo(1), summary: 'Became public after' });

  // ⚠️ REQUIREMENT 4. This is the whole feature: subscribing must not hand you the past.
  ok('⚠️ evidence public BEFORE the subscription generates nothing',
    alertsFor([older], subscribedAt, { now: NOW }).length === 0);
  // ⚠️ REQUIREMENT 5.
  ok('⚠️ evidence public AFTER the subscription generates exactly one alert',
    alertsFor([newer], subscribedAt, { now: NOW }).length === 1);
  ok('…and a mixed batch yields only the new one',
    alertsFor([older, newer], subscribedAt, { now: NOW }).map((a) => a.detail).join() === 'Became public after');
  ok('evidence exactly AT the watermark is not new', alertsFor([ev({ publicTime: subscribedAt })], subscribedAt, { now: NOW }).length === 0);

  // ⚠️ REQUIREMENT 8 — Form 4 on filing availability, not the transaction.
  const form4 = ev({ family: FAMILY.INSIDER, type: 'insider_cluster_buy', summary: 'SVP sold $816K',
    eventTime: daysAgo(30), publicTime: hoursAgo(1) });
  ok('⚠️ a Form 4 alerts on its FILING time even when the trade was a month earlier',
    alertsFor([form4], subscribedAt, { now: NOW }).length === 1);
  ok('…and NOT on the transaction date, which would have been outside the window',
    alertsFor([ev({ family: FAMILY.INSIDER, type: 'insider_cluster_buy', summary: 's', eventTime: hoursAgo(1), publicTime: daysAgo(30) })],
      subscribedAt, { now: NOW }).length === 0);

  // ⚠️ REQUIREMENT 7 — Congress on disclosure, not trade date.
  const congress = ev({ family: FAMILY.CONGRESS, type: 'congress_purchase',
    summary: 'Representative bought $1,001 - $15,000', eventTime: daysAgo(44), publicTime: hoursAgo(1) });
  ok('⚠️ a congressional disclosure alerts on the DISCLOSURE date, 44 days after the trade',
    alertsFor([congress], subscribedAt, { now: NOW }).length === 1
    && alertsFor([congress], subscribedAt, { now: NOW })[0].publicTime === new Date(Date.parse(hoursAgo(1))).toISOString());

  // ⚠️ 13F — the quarter end is not the alert timestamp.
  const f13 = ev({ family: FAMILY.INSTITUTION, type: 'institution_breadth_change', summary: '12 new holders',
    eventTime: daysAgo(87), publicTime: hoursAgo(1), referencePeriod: '2026Q2' });
  ok('⚠️ a 13F alerts on the filing, not the quarter end three months earlier',
    alertsFor([f13], subscribedAt, { now: NOW }).length === 1);

  // ⚠️ REQUIREMENT 9 — fail closed.
  ok('⚠️ an unreadable watermark generates NOTHING rather than everything',
    alertsFor([newer], 'not-a-date', { now: NOW }).length === 0
    && alertsFor([newer], null, { now: NOW }).length === 0
    && alertsFor([newer], undefined, { now: NOW }).length === 0);
  ok('⚠️ a future publicTime beyond the engine\'s tolerance is refused',
    alertsFor([{ ...ev(), publicTime: new Date(NOW + FUTURE_TOLERANCE_MS + 60000).toISOString() }], subscribedAt, { now: NOW }).length === 0);
  ok('…and a malformed publicTime is refused by the row builder too',
    toAlert({ ...ev(), publicTime: 'yesterday' }) === null && toAlert({ ...ev(), publicTime: null }) === null);
  ok('⚠️ evidence with no canonical id cannot alert, because it cannot be deduped',
    toAlert({ ...ev(), evidenceId: '' }) === null && toAlert({ ...ev(), evidenceId: null }) === null);
  ok('⚠️ an ambiguous ticker cannot alert', toAlert({ ...ev(), ticker: '' }) === null
    && toAlert({ ...ev(), ticker: 'not a ticker' }) === null);
  ok('…and evidence with nothing to say is not padded with an invented sentence',
    toAlert({ ...ev(), summary: null, type: null }) === null);
}

L('⚠️ DEDUPLICATION: ONE REAL-WORLD EVENT, ONE ALERT');
{
  // ⚠️ REQUIREMENT 6. The engine's evidenceId is the identity; this layer must not add a second one.
  const one = ev({ summary: 'Material agreement', type: 'sec_8k_material_agreement' });
  ok('⚠️ the same evidence twice in one batch yields one alert',
    alertsFor([one, { ...one }], hoursAgo(3), { now: NOW }).length === 1);
  ok('…and identity is the ENGINE\'s canonical id, not one minted here',
    toAlert(one).evidenceId === one.evidenceId && /\|/.test(one.evidenceId));

  // ⚠️ AND THE DURABLE HALF IS A UNIQUE INDEX, NOT AN APPLICATION CHECK. A "have I sent this?"
  // read-then-write races with itself across two overlapping cron runs; a unique index cannot.
  const store = read('../src/lib/alerts/evidence-alert-store.js');
  ok('⚠️ one alert per person per event is enforced in Postgres',
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_alert[\s\S]{0,80}\(user_id, evidence_id\)/.test(store));
  ok('⚠️ …and re-processing is a no-op rather than an error',
    /on conflict \(user_id, evidence_id\) do nothing/.test(store));
  ok('⚠️ one subscription per person per ticker is enforced the same way',
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_alert_sub[\s\S]{0,80}\(user_id, ticker\)/.test(store)
    && /on conflict \(user_id, ticker\) do update/.test(store));
  ok('…and the worker keeps no cursor that a partial failure could advance past',
    !/last_run|cursor|watermark_table|lastProcessed/i.test(code(read('../src/lib/alerts/evidence-alert-worker.mjs'))));
}

L('⚠️ RE-ENABLING STARTS THE CLOCK AGAIN');
{
  const store = read('../src/lib/alerts/evidence-alert-store.js');
  // ⚠️ THE BACKLOG BUG THIS PREVENTS: a subscription created in March, disabled, and re-enabled
  // today would — if the watermark were created_at — deliver six months of evidence at once.
  ok('⚠️ the watermark is enabled_at, not created_at', /enabled_at TIMESTAMPTZ NOT NULL/.test(store)
    && /select user_id, ticker, enabled_at from evidence_alert_subs/.test(store));
  ok('⚠️ …and it moves only on an off→on transition, so a stray re-save cannot skip pending evidence',
    /when excluded\.enabled and not evidence_alert_subs\.enabled\s*\n?\s*then now\(\) else evidence_alert_subs\.enabled_at end/.test(store));
}

L('⚠️ ENTITLEMENT IS SERVER-SIDE');
{
  // ⚠️ REQUIREMENT 3. Hiding a button is layout, not access control.
  const route = code(read('../src/app/api/evidence-alerts/route.js'));
  ok('⚠️ creating a subscription requires Pro, resolved on the server',
    /async function requirePro\(\)/.test(route) && /export async function POST/.test(route)
    && /const gate = await requirePro\(\);/.test(route));
  ok('…using the project\'s existing entitlement resolver, not a new one',
    /resolveUserAccess/.test(route) && !/publicMetadata|stripe/i.test(route));
  // ⚠️ EVERY lookup, not one of them. The route resolves entitlement twice — once to gate POST and
  // once to tell GET whether to show the controls — and a count floor let one of the two be
  // flipped to grant Pro on a Clerk outage while the other still read 'free'.
  ok('⚠️ an entitlement lookup FAILURE denies rather than grants, at every call site',
    (route.match(/catch \{ tier = 'free'; \}/g) || []).length === (route.match(/resolveUserAccess\(\)/g) || []).length
    && (route.match(/resolveUserAccess\(\)/g) || []).length === 2
    && !/tier = '(pro|elite)'/.test(route));
  // ⚠️ AND READING THE SUBSCRIPTION LIST IS NOT GATED. A free user's page needs `pro:false` to
  // render the control as an upsell; refusing the read would break the signed-in free experience.
  ok('⚠️ the subscription list is readable without Pro, so a free page can render honestly',
    /export async function GET\(\) \{[\s\S]{0,200}if \(!userId\) return Response\.json\(\{ pro: false, tickers: \[\] \}/.test(route)
    && !/export async function GET\(\) \{[\s\S]{0,120}requirePro/.test(route));
  // ⚠️ AND THE `pro` FLAG IT REPORTS IS DERIVED FROM THE TIER, FULL STOP. Widening it does not
  // breach the POST gate, but it would show a Pro control to a free user and let them discover the
  // feature by being refused — which is a worse first experience than not seeing it.
  ok('⚠️ the pro flag is the tier and nothing else',
    /const pro = PRO_TIERS\.has\(tier\);/.test(route) && !/pro = [^;]*\|\|/.test(route));
  ok('a signed-out caller is refused', /if \(!userId\) return \{ error: 'unauthorized', status: 401 \}/.test(route));
  ok('⚠️ …and reading your own existing alerts is not gated, so a lapse never looks like data loss',
    !/requirePro/.test(code(read('../src/app/api/evidence-alerts/inbox/route.js'))));
  ok('subscriptions are bounded per user', /MAX_SUBS_PER_USER/.test(read('../src/lib/alerts/evidence-alert-store.js')));
}

L('⚠️ GENERATION IS BATCHED — NO PER-TICKER RESOLUTION');
{
  // ⚠️ REQUIREMENT 15. tickerEvidence() is ~16 round trips; running it per subscribed ticker
  // directly is precisely the N+1 the brief forbids.
  const w = code(read('../src/lib/alerts/evidence-alert-worker.mjs'));
  ok('⚠️ the worker prefetches every family once for a whole chunk of tickers',
    /loadBuildContext\(db, sql, group, \{ now \}\)/.test(w));
  ok('⚠️ …and every resolve reads that context rather than the database',
    /tickerEvidence\(ticker, \{ now, ctx \}\)/.test(w) && !/tickerEvidence\([^)]*\)\s*;?\s*$/m.test(w.replace(/tickerEvidence\(ticker, \{ now, ctx \}\)/g, '')));
  ok('⚠️ …and a prefetch failure SKIPS the chunk rather than falling back to per-ticker queries',
    /catch \{[\s\S]{0,320}failed \+= group\.length;[\s\S]{0,40}continue;/.test(w));
  ok('it is chunked, so one run cannot hold every ticker in memory', /chunkTickers\(tickers, CHUNK\)/.test(w));
  ok('…and bounded in both tickers and wall time',
    /MAX_TICKERS_PER_RUN/.test(w) && /Date\.now\(\) - startedAt > budgetMs/.test(w));
  ok('subscriptions are read in ONE statement for the whole system',
    /select user_id, ticker, enabled_at from evidence_alert_subs/.test(read('../src/lib/alerts/evidence-alert-store.js')));
  ok('…and delivery is one statement per batch', /insert into evidence_alerts[\s\S]{0,400}values \$\{sql\.join/.test(read('../src/lib/alerts/evidence-alert-store.js')));

  // ⚠️ FAIL CLOSED IN THE WORKER TOO.
  ok('⚠️ a resolution failure creates no alert', /catch \{[\s\S]{0,400}failed\+\+;[\s\S]{0,40}continue;/.test(w));
  ok('⚠️ an unreadable subscriber watermark delivers nothing',
    /if \(!Number\.isFinite\(subSince\)\) continue;/.test(w));
  ok('⚠️ the lookback can only ever NARROW what a subscriber receives',
    /Math\.max\(subSince, Date\.parse\(floor\)\)/.test(w));
  ok('generation is server-side and scheduled, never the browser\'s job',
    /export const maxDuration/.test(read('../src/app/api/cron/evidence-alerts/route.js'))
    && JSON.parse(read('../vercel.json')).crons.some((c) => c.path === '/api/cron/evidence-alerts'));
  ok('the cron follows the existing auth convention',
    /x-vercel-cron|CRON_SECRET/.test(read('../src/app/api/cron/evidence-alerts/route.js')));
}

L('⚠️ THE INBOX READS ROWS, NOT THE EVIDENCE ENGINE');
{
  const inbox = code(read('../src/app/api/evidence-alerts/inbox/route.js'));
  // ⚠️ REQUIREMENT 14 (performance). The bell polls every 60s on every signed-in page; resolving
  // evidence there would put a multi-family build behind every one of those.
  ok('⚠️ the inbox never touches the Evidence Engine',
    !/tickerEvidence|resolve\.js|loadBuildContext|evidence\/resolve/.test(inbox));
  ok('…it reads persisted alert rows', /listAlerts\(userId\)/.test(inbox));
  // ⚠️ REQUIREMENT 10 + 6.
  ok('⚠️ read state is persisted server-side, not in the browser',
    /markRead\(userId/.test(inbox) && /update evidence_alerts set read = true/.test(read('../src/lib/alerts/evidence-alert-store.js')));
  ok('⚠️ …and marking read is scoped to the owner in the statement',
    /update evidence_alerts set read = true where user_id = \$\{userId\} and id = \$\{n\}/.test(read('../src/lib/alerts/evidence-alert-store.js')));
  ok('both an individual mark and mark-all exist', /all: b\?\.all === true/.test(inbox));

  // ⚠️ REQUIREMENT 13. Bounded history, but never at the cost of something unseen.
  const store = read('../src/lib/alerts/evidence-alert-store.js');
  ok('⚠️ unread alerts are kept longer than read ones', UNREAD_RETENTION_DAYS > RETENTION_DAYS);
  ok('…and the prune says so in one statement',
    /\(read and created_at <[\s\S]{0,80}RETENTION_DAYS[\s\S]{0,120}not read and created_at <[\s\S]{0,80}UNREAD_RETENTION_DAYS/.test(store));
  ok('the inbox is bounded', /INBOX_LIMIT/.test(store) && /Math\.min\(200/.test(store));
  ok('the catch-up lookback is a margin, not a window a subscriber can see past',
    Number.isFinite(LOOKBACK_DAYS) && LOOKBACK_DAYS > 0);
}

L('⚠️ THE SURFACES: ONE REQUEST, NOT ONE PER TICKER');
{
  const client = code(read('../src/lib/alerts/alert-subs-client.js'));
  const toggle = code(read('../src/components/AlertToggle.jsx'));
  // ⚠️ REQUIREMENT 15 again, on the read side: a hundred Pit Scan rows must not be a hundred GETs.
  ok('⚠️ the subscribed set is fetched once and shared by every control on the page',
    /let cache = null;/.test(client) && /if \(!cache\) cache = fetchSubs\(\);/.test(client));
  ok('⚠️ …and no control asks the server about its own ticker',
    !/fetch\(/.test(toggle) && /loadAlertSubs\(\)/.test(toggle));
  // ⚠️ STATED AS AN INVARIANT OVER THE WHOLE FILE, NOT AS A SHAPE NEAR A `catch`. The first
  // version matched `catch {` within 300 characters of a closed return, and an unrelated catch in
  // emit() satisfied it — so a mutation that made the failure path claim `pro: true` survived.
  // What actually matters is that this module never invents entitlement or membership at all.
  ok('⚠️ a failed load can never claim Pro, or claim a ticker is subscribed',
    !/pro: true/.test(client) && !/tickers: new Set\(\[/.test(client)
    && (client.match(/return \{ pro: false, tickers: new Set\(\) \};/g) || []).length === 2);
  ok('⚠️ a refused toggle does not leave the control claiming a subscription',
    /const next = await toggleAlert\(sym\);\s*\n\s*setOn\(next\);/.test(toggle) && /catch \(err\)/.test(toggle));
  ok('the server\'s answer is what lands in the set, not an optimistic guess',
    /cache = Promise\.resolve\(next\);/.test(client) && /new Set\(j\.tickers \|\| \[\]\)/.test(client));

  // ⚠️ REQUIREMENTS 12 + 13 (UI state).
  ok('⚠️ the wording is Alert / Alert On', /const label = on \? 'Alert On' : 'Alert';/.test(toggle));
  const scan = read('../src/components/scan/ScanBoardRows.jsx');
  ok('⚠️ the Pit Scan Alert action is now the real control',
    /<AlertToggle symbol=\{r\.ticker\} onNotice=\{onAlert\} \/>/.test(scan));
  ok('…and it no longer posts the old news-rule alert', !/type: 'news'/.test(scan));
  ok('⚠️ …and it means "monitor this ticker", not "alert me about this row"',
    !/scanRow|rowId|boardName/.test(code(read('../src/components/AlertToggle.jsx'))));
  ok('the ticker page carries the control beside the watchlist star',
    /<AlertToggle symbol=\{data\.symbol\} variant="button" \/><WatchlistStar/.test(read('../src/app/ticker/[symbol]/TickerPage.jsx')));
  const term = read('../src/app/terminal/TerminalClient.jsx');
  ok('the watchlist row carries a compact one', /<AlertToggle symbol=\{r\.ticker\} variant="icon" \/>/.test(term));
  // ⚠️ REQUIREMENT 14. Watchlist and Alerts are separate intents.
  ok('⚠️ watching a ticker does not subscribe it', !/toggleAlert|setSubscription/.test(term));
  ok('⚠️ …and the What Changed line is untouched',
    /\{sig\.changes\?\.\[r\.ticker\] && \(/.test(term) && /const old = change\.historical === true;/.test(term));
}

L('⚠️ THE BELL: EXISTING ICON, BOTH SOURCES, HONEST COUNT');
{
  const shared = read('../src/lib/cp-shared.jsx');
  // ⚠️ REQUIREMENT 11.
  ok('⚠️ the existing bell is reused rather than a second destination invented',
    (shared.match(/export function NotificationBell/g) || []).length === 1
    && /\/api\/evidence-alerts\/inbox/.test(shared));
  ok('⚠️ the badge counts both sources', /\(unread \+ alertUnread\) > 0/.test(shared));
  // ⚠️ REQUIREMENT 6. Opening must not silently discard what the trader asked to be told.
  ok('⚠️ opening the bell does NOT mark evidence alerts read',
    /if \(next && unread > 0\) \{ setUnread\(0\);/.test(shared) && !/setAlertUnread\(0\)[\s\S]{0,60}setOpen\(next\)/.test(shared));
  ok('…an alert is marked read when it is opened', /onClick=\{open\}/.test(shared) && /onRead\(a\.id\);/.test(shared));
  ok('…and Mark all read exists', /Mark all read/.test(shared) && /readAllAlerts/.test(shared));
  ok('the social notifications path is unchanged',
    /const r = await fetch\('\/api\/notifications', \{ cache: 'no-store' \}\);/.test(shared)
    && /fetch\('\/api\/notifications', \{ method: 'POST' \}\)/.test(shared));
  ok('the empty state accounts for both', /list\.length === 0 && alerts\.length === 0/.test(shared));

  // ⚠️ REUSE THE TERMINAL'S INSPECTOR RATHER THAN NAVIGATING OUT OF THE WORKSPACE.
  ok('⚠️ inside the Terminal an alert opens the existing Evidence inspector',
    /inspectEvidence\(a\.ticker\);/.test(shared) && /evidenceInspectorAvailable\(\)/.test(shared));
  ok('⚠️ …and it asks the bus rather than sniffing the URL',
    !/pathname[\s\S]{0,40}terminal/.test(shared.split('function EvidenceAlertRow')[1]?.split('\n}')[0] || ''));
  ok('…while off the Terminal it is an ordinary ticker link',
    /href=\{`\/ticker\/\$\{encodeURIComponent\(a\.ticker\)\}`\}/.test(shared));
  ok('the row shows ticker, family, the engine\'s sentence and the age',
    /\{a\.ticker\}/.test(shared) && /\{a\.title\}/.test(shared) && /\{a\.detail\}/.test(shared)
    && /timeAgo\(minsSince\(a\.publicTime\)\)/.test(shared));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
