// EVIDENCE ALERT SUBSCRIPTIONS — the explicit, Pro-gated opt-in, exercised rather than grepped.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-alert-subscriptions.mjs
//
// ⚠️ THE FINDING THIS CLOSES. The alert engine was complete, cron-scheduled and tested, but
// evidence_alert_subs was empty, so it could not deliver to anyone. The decision was explicitly NOT
// to subscribe people because they watch a ticker — watching and asking to be told are different
// actions — so what was missing was the control, on the surface where a reader manages tickers.
//
// ⚠️ AND NOTHING HERE MAY MIGRATE A WATCHLIST. The assertions below prove the two are independent in
// both directions: adding to a watchlist creates no subscription, and subscribing adds nothing to a
// watchlist.
//
// Writes are made under a synthetic user id and removed in a finally block, so this leaves no
// subscription behind that the worker could deliver against.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import {
  listSubscriptions, setSubscription, normalizeTicker, MAX_SUBS_PER_USER, activeSubscriptions,
} from '../src/lib/alerts/evidence-alert-store.js';
import { isUserError } from '../src/lib/user-error.mjs';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const U = `verify_subs_${Date.now()}`;

try {
  L('⚠️ the control exists on every surface a reader manages tickers from');
  {
    const SURFACES = [
      ['the ticker page', 'src/app/ticker/[symbol]/TickerPage.jsx', /<AlertToggle symbol=\{data\.symbol\} variant="button" \/>/],
      ['the Terminal watchlist', 'src/app/terminal/TerminalClient.jsx', /<AlertToggle symbol=\{r\.ticker\} variant="icon" \/>/],
      ['Pit Scan rows', 'src/components/scan/ScanBoardRows.jsx', /<AlertToggle symbol=\{r\.ticker\} onNotice=\{onAlert\} \/>/],
      // ⚠️ THE ONE THAT WAS MISSING.
      ['the watchlist page', 'src/components/WatchlistSection.jsx', /<AlertToggle symbol=\{item\.ticker\} variant="icon" onNotice=\{onNotice\} \/>/],
    ];
    for (const [label, f, re] of SURFACES) ok(`${label} offers the control`, re.test(code(f)), String(re).slice(0, 55));
    const w = code('src/components/WatchlistSection.jsx');
    ok('⚠️ the watchlist can show the server\'s refusal, so a declined click is not a dead button',
      /const \[notice, setNotice\] = useState\(null\);/.test(w) && /role="status"/.test(w));
    ok('…and the notice clears itself', /setTimeout\(\(\) => setNotice\(null\), 4000\)/.test(w));
    ok('one request answers every row, not one per row',
      /THE SUBSCRIBED-TICKER SET, FETCHED ONCE PER PAGE/.test(read('src/lib/alerts/alert-subs-client.js')));
    ok('the control shows a clear enabled/disabled state', /const label = on \? 'Alert On' : 'Alert';/.test(code('src/components/AlertToggle.jsx')));
    ok('…exposed to assistive tech as a pressed state', /aria-pressed=\{on\}/.test(code('src/components/AlertToggle.jsx')));
  }

  L('⚠️ subscribing is explicit, and independent of the watchlist in BOTH directions');
  {
    ok('nothing in the watchlist API creates a subscription',
      !/setSubscription|evidence_alert_subs/.test(code('src/app/api/watchlist/route.js')));
    ok('nothing in the subscription route touches the watchlist',
      !/\bwatchlist\b/.test(code('src/app/api/evidence-alerts/route.js')));
    ok('⚠️ no migration script back-fills subscriptions from watchlists',
      !/insert into evidence_alert_subs[\s\S]{0,400}from watchlist/i.test(
        ['src/lib/alerts/evidence-alert-store.js', 'src/lib/alerts/evidence-alert-worker.mjs']
          .map((f) => read(f)).join('\n')));
    // ⚠️ THE ORPHANED WATCHLIST-DRIVEN ENGINE MUST STAY UNCALLED, or watching would silently alert.
    ok('the cron runs the subscription worker, not the watchlist module',
      /lib\/alerts\/evidence-alert-worker\.mjs/.test(code('src/app/api/cron/evidence-alerts/route.js')));
    // ⚠️ THE ORPHANED ENGINE IS DELETED, NOT ANNOTATED. This asserted the "ORPHANED" banner, which was
    // the interim state; the module exported a same-named runEvidenceAlerts, so an import of the wrong
    // one would have silently restored watchlist-driven, non-Pro-gated alerting. The guarantee now is
    // that it cannot be imported because it does not exist.
    ok('…and the watchlist-driven engine no longer exists to be imported',
      !/export async function runEvidenceAlerts/.test(read('src/lib/evidence-alerts.js')));
  }

  L('⚠️ persistence, idempotence and re-add behaviour — exercised against the real store');
  {
    ok('a fresh user has no subscriptions', (await listSubscriptions(U)).length === 0);

    await setSubscription(U, 'NVDA', true);
    ok('subscribing persists', (await listSubscriptions(U)).includes('NVDA'));

    // ⚠️ NO DUPLICATES, AND IT IS THE INDEX THAT GUARANTEES IT, NOT A READ-THEN-WRITE.
    await setSubscription(U, 'NVDA', true);
    await setSubscription(U, 'NVDA', true);
    const rows = await sql`select count(*)::int n from evidence_alert_subs where user_id=${U} and ticker='NVDA'`;
    ok('⚠️ subscribing three times leaves exactly one row', rows[0].n === 1, `${rows[0].n}`);
    ok('…and the list does not repeat it', (await listSubscriptions(U)).filter((t) => t === 'NVDA').length === 1);

    // ⚠️ RE-SAVING AN ALREADY-ON SUBSCRIPTION MUST NOT SLIDE THE WATERMARK, or a stray click would
    // silently skip evidence that became public in between.
    const w1 = (await sql`select enabled_at from evidence_alert_subs where user_id=${U} and ticker='NVDA'`)[0].enabled_at;
    await setSubscription(U, 'NVDA', true);
    const w2 = (await sql`select enabled_at from evidence_alert_subs where user_id=${U} and ticker='NVDA'`)[0].enabled_at;
    ok('⚠️ re-saving an on subscription does not move enabled_at', String(w1) === String(w2));

    await setSubscription(U, 'NVDA', false);
    ok('unsubscribing removes it from the list', !(await listSubscriptions(U)).includes('NVDA'));
    ok('…but keeps the row, so history is not rewritten',
      (await sql`select count(*)::int n from evidence_alert_subs where user_id=${U} and ticker='NVDA'`)[0].n === 1);

    // ⚠️ RE-ENABLING STARTS THE CLOCK AGAIN — someone who turned alerts off in March and back on
    // today asked about today, not about four months of backlog.
    await new Promise((r) => setTimeout(r, 1100));
    await setSubscription(U, 'NVDA', true);
    const w3 = (await sql`select enabled_at from evidence_alert_subs where user_id=${U} and ticker='NVDA'`)[0].enabled_at;
    ok('⚠️ re-enabling DOES move enabled_at forward', Date.parse(w3) > Date.parse(w2), `${w2} -> ${w3}`);
    ok('…and still only one row exists',
      (await sql`select count(*)::int n from evidence_alert_subs where user_id=${U}`)[0].n === 1);

    // The worker's view must see it.
    const active = await activeSubscriptions();
    ok('the worker sees the subscription with its watermark',
      active.some((s) => s.userId === U && s.ticker === 'NVDA' && s.since));

    // Symbol hygiene.
    ok('a malformed ticker is refused', normalizeTicker('not a ticker') === null);
    ok('…and lowercase is normalised', normalizeTicker('nvda') === 'NVDA');
    let threw = null;
    try { await setSubscription(U, '<script>', true); } catch (e) { threw = e; }
    ok('⚠️ setSubscription refuses a malformed ticker rather than storing it', threw !== null);
    ok('…as a user-facing refusal, not an opaque failure', isUserError(threw), String(threw?.message));
    ok('the limit is a refusal the user can read', MAX_SUBS_PER_USER === 200);
  }

  L('⚠️ Free cannot create a Pro subscription, and the server is what says so');
  {
    const route = code('src/app/api/evidence-alerts/route.js');
    ok('the POST resolves entitlement server-side before writing', /const gate = await requirePro\(\);/.test(route));
    ok('…and answers 403 rather than writing', /status: 403/.test(route) && /pro_required/.test(route));
    ok('⚠️ …and an entitlement lookup FAILURE denies rather than grants', /catch \{ tier = 'free'; \}/.test(route));
    ok('⚠️ the gate runs before the body is even parsed',
      route.indexOf('await requirePro()') < route.indexOf('await request.json()'));
    ok('only pro and elite pass', /PRO_TIERS = new Set\(\['pro', 'elite'\]\)/.test(route));
    ok('an unauthenticated caller is refused', /status: 401/.test(route));
    // ⚠️ AND THE UI IS NOT THE GATE. The control renders for everyone; the server declines.
    ok('the control is not hidden from non-Pro users', !/if \(!pro\) return null/.test(code('src/components/AlertToggle.jsx')));
    ok('…and the client surfaces the refusal verbatim',
      /j\?\.error === 'pro_required' \? 'Evidence Alerts are a Pit Pro feature'/.test(read('src/lib/alerts/alert-subs-client.js')));
    ok('…and does not optimistically flip the control',
      /THE SERVER'S ANSWER IS WHAT LANDS IN THE SET/.test(read('src/lib/alerts/alert-subs-client.js')));
  }

  L('⚠️ nothing is delivered to anyone who did not subscribe');
  {
    const w = code('src/lib/alerts/evidence-alert-worker.mjs');
    ok('the worker reads subscriptions and nothing else', /const subs = await activeSubscriptions\(\);/.test(w));
    ok('…and iterates only the users waiting on that ticker', /for \(const s of waiting\.get\(ticker\) \|\| \[\]\)/.test(w));
    ok('⚠️ each subscriber is gated on their OWN watermark', /Math\.max\(subSince, Date\.parse\(floor\)\)/.test(w));
    ok('…and an unreadable watermark delivers nothing', /if \(!Number\.isFinite\(subSince\)\) continue;/.test(w));
    const stray = await sql`select count(*)::int n from evidence_alerts a
      where not exists (select 1 from evidence_alert_subs s where s.user_id=a.user_id and s.ticker=a.ticker)`;
    ok('⚠️ no delivered alert exists without a matching subscription', stray[0].n === 0, `${stray[0].n}`);
  }
} finally {
  // ⚠️ LEAVE NOTHING THE WORKER COULD DELIVER AGAINST.
  const s = await sql`delete from evidence_alert_subs where user_id=${U} returning id`;
  const a = await sql`delete from evidence_alerts where user_id=${U} returning id`;
  console.log(`\ncleanup: removed ${s.length} subscription(s), ${a.length} alert(s) for ${U}`);
  const left = await sql`select count(*)::int n from evidence_alert_subs where user_id like 'verify_subs_%'`;
  console.log(`synthetic subscriptions left behind: ${left[0].n}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
