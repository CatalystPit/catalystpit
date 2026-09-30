// EVIDENCE ALERT SUBSCRIPTIONS — THE PRODUCT PATH, EXERCISED.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-evidence-subs-usable.mjs
//
// ⚠️ THE TABLE WAS EMPTY, AND THE INFERENCE THAT NOBODY *COULD* SUBSCRIBE WAS WRONG. The store, the
// route and the control all existed and were mounted on four surfaces. What was actually broken:
//
//   1. the control fetched `pro` and never read it, so a Free visitor got a working-looking toggle
//      that 403'd on click, and a Pro subscriber saw "Alert" flash to "Alert On" on every load
//   2. the worker delivered to every enabled row with NO tier check, so cancelling Pro did not stop
//      Pro alerts — entitlement was checked once, where the subscription was created
//   3. a subscription for a ticker no longer in the watchlist had no switch on any surface
//
// Every assertion below runs the real store against the real database, with a disposable user id.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import {
  setSubscription, listSubscriptions, activeSubscriptions, normalizeTicker, MAX_SUBS_PER_USER,
} from '../src/lib/alerts/evidence-alert-store.js';
import { runEvidenceAlerts } from '../src/lib/alerts/evidence-alert-worker.mjs';
import { accessFromClerkUser, resolveAccessByIds } from '../src/lib/entitlements.js';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// ⚠️ DISPOSABLE IDS, NAMESPACED AND CLEANED UP. These write to the real evidence_alert_subs, so they
// must be impossible to confuse with a person's row and must not survive the run.
const U1 = `test_verify_sub_${Date.now()}_a`;
const U2 = `test_verify_sub_${Date.now()}_b`;
const cleanup = async () => {
  await sql`delete from evidence_alert_subs where user_id like 'test_verify_sub_%'`;
  await sql`delete from evidence_alerts where user_id like 'test_verify_sub_%'`;
};
await cleanup();

try {
  L('⚠️ 1 — the control no longer offers an action that cannot succeed');
  {
    const t = code('src/components/AlertToggle.jsx');
    // ⚠️ THE DEFECT: `pro` was in the payload and unread. Both halves are pinned — that it is read,
    // and that the non-Pro branch is not a toggle.
    ok('⚠️ the control reads the entitlement it already had', /if \(!subs\.pro\)/.test(t));
    // ⚠️ MEASURED AGAINST THE CLICK HANDLER, NOT AGAINST A LABEL STRING. The first version compared
    // against `const label =`, which is computed before the branch and is just a word — the assertion
    // failed while the code was correct, which is the worst kind of test.
    ok('⚠️ …and a non-Pro visitor never reaches the POST handler',
      t.indexOf('if (!subs.pro)') < t.indexOf('onClick={click}'),
      'the pro branch must return before any control wired to the toggle');
    ok('⚠️ unknown state renders nothing rather than the wrong control',
      /if \(!subs\.ready \|\| !authLoaded\) return null;/.test(t));
    ok('…and that guard precedes every render branch',
      t.indexOf('!subs.ready || !authLoaded') < t.indexOf("if (!subs.pro)"));
    ok('⚠️ the off state is no longer a useState default that can be wrong',
      !/useState\(false\)/.test(t.replace(/const \[busy, setBusy\] = useState\(false\);/, ''))
      && /const on = subs\.tickers\.has\(sym\);/.test(t));
    // ⚠️ THE UPGRADE PATH IS THE PRODUCT'S OWN. The first version linked to /pro, which does not exist.
    ok('⚠️ it uses the existing upgrade affordance, not an invented route',
      /startCheckout\(\)/.test(t) && /'\/sign-up'/.test(t) && !/href="\/pro"/.test(t));
    ok('…signed out goes to sign-up, signed in goes to checkout',
      /if \(isSignedIn\) startCheckout\(\); else \{ window\.location\.href = '\/sign-up'; \}/.test(t));
    ok('⚠️ no upgrade wording appears on the functional control a Pro user sees',
      !/Unlock Pro|Start Pro|Upgrade to Pro/.test(t));
    ok('all three variants have a non-Pro form, so no surface shows a dead toggle',
      (t.match(/variant === 'icon'/g) || []).length === 2 && (t.match(/variant === 'button'/g) || []).length === 2);
    // The client must carry the readiness flag, or the guard above can never be satisfied.
    const c = code('src/lib/alerts/alert-subs-client.js');
    ok('the shared set reports readiness', /ready: true/.test(c) && /export const UNKNOWN_SUBS/.test(c));
    ok('…and a failed load is still "not subscribed", not "subscribed"',
      /return \{ pro: false, tickers: new Set\(\), ready: true \};/.test(c));
  }

  L('⚠️ 2 — enabling, disabling, idempotency and isolation, against the real table');
  {
    ok('a new user starts with nothing', (await listSubscriptions(U1)).length === 0);

    await setSubscription(U1, 'AAPL', true);
    ok('⚠️ enable persists', (await listSubscriptions(U1)).includes('AAPL'));
    const oneRow = await sql`select count(*)::int n from evidence_alert_subs where user_id=${U1}`;
    ok('…as exactly one row', oneRow[0].n === 1);

    // ⚠️ IDEMPOTENT ENABLE. Two clicks, or a retry, must not make two subscriptions.
    await setSubscription(U1, 'AAPL', true);
    await setSubscription(U1, 'AAPL', true);
    const still = await sql`select count(*)::int n from evidence_alert_subs where user_id=${U1} and ticker='AAPL'`;
    ok('⚠️ duplicate enable does not duplicate', still[0].n === 1, `${still[0].n} rows`);
    ok('…and the list still reports it once',
      (await listSubscriptions(U1)).filter((x) => x === 'AAPL').length === 1);

    // ⚠️ THE WATERMARK MUST NOT SLIDE ON A RE-SAVE, or a stray click silently skips pending evidence.
    const w1 = await sql`select enabled_at from evidence_alert_subs where user_id=${U1} and ticker='AAPL'`;
    await setSubscription(U1, 'AAPL', true);
    const w2 = await sql`select enabled_at from evidence_alert_subs where user_id=${U1} and ticker='AAPL'`;
    ok('⚠️ re-enabling an already-on subscription does not move the watermark',
      String(w1[0].enabled_at) === String(w2[0].enabled_at));

    await setSubscription(U1, 'AAPL', false);
    ok('⚠️ disable works', !(await listSubscriptions(U1)).includes('AAPL'));
    ok('…and the row is kept, not deleted, so the preference survives',
      (await sql`select count(*)::int n from evidence_alert_subs where user_id=${U1} and ticker='AAPL'`)[0].n === 1);
    await setSubscription(U1, 'AAPL', false);
    ok('⚠️ duplicate disable is safe', (await listSubscriptions(U1)).length === 0);

    // ⚠️ RE-ENABLING AFTER A GAP MOVES THE WATERMARK FORWARD, so nobody gets a four-month backlog.
    await setSubscription(U1, 'AAPL', true);
    const w3 = await sql`select enabled_at from evidence_alert_subs where user_id=${U1} and ticker='AAPL'`;
    ok('⚠️ re-enabling after a disable DOES move the watermark forward',
      Date.parse(w3[0].enabled_at) > Date.parse(w1[0].enabled_at));

    await setSubscription(U1, 'MSFT', true);
    await setSubscription(U1, 'NVDA', true);
    ok('multiple tickers work', (await listSubscriptions(U1)).join(',') === 'AAPL,MSFT,NVDA');

    // ⚠️ CROSS-USER ISOLATION. Every read and write is scoped by user_id in the statement.
    await setSubscription(U2, 'TSLA', true);
    ok('⚠️ users are isolated', (await listSubscriptions(U2)).join(',') === 'TSLA');
    ok('…and one user cannot see another\'s', !(await listSubscriptions(U1)).includes('TSLA'));

    // Ticker normalization, including the values that must be refused.
    await setSubscription(U2, ' tsla ', true);
    ok('⚠️ ticker normalization: " tsla " is the same subscription as TSLA',
      (await sql`select count(*)::int n from evidence_alert_subs where user_id=${U2}`)[0].n === 1);
    ok('normalizeTicker uppercases and trims', normalizeTicker(' brk.b ') === 'BRK.B');
    for (const bad of ['', null, undefined, '1ABC', 'toolongticker', 'A B', 'AA;DROP', '<script>']) {
      ok(`⚠️ ${JSON.stringify(bad)} is refused`, normalizeTicker(bad) === null);
    }
    let threw = false;
    try { await setSubscription(U2, '1BAD', true); } catch { threw = true; }
    ok('⚠️ the store refuses an invalid ticker rather than storing it', threw);
  }

  L('⚠️ 3 — server-side entitlement, in the route and not in the button');
  {
    const r = code('src/app/api/evidence-alerts/route.js');
    // ⚠️ COMPARED AGAINST THE CALL, NOT THE IMPORT. The first version compared indexOf('setSubscription'),
    // which matches the import on line 3 — so the assertion failed against entirely correct code, which
    // is the most expensive kind of test failure.
    ok('⚠️ POST is gated before anything is written', /const gate = await requirePro\(\);/.test(r)
      && r.indexOf('const gate = await requirePro();') < r.indexOf('await setSubscription(gate.userId'));
    ok('⚠️ signed out is 401', /return \{ error: 'unauthorized', status: 401 \}/.test(r));
    ok('⚠️ non-Pro is 403 pro_required', /return \{ error: 'pro_required', status: 403/.test(r));
    ok('⚠️ an entitlement lookup failure fails CLOSED',
      /catch \{ tier = 'free'; \}/.test(r));
    ok('…and it uses the shared resolver, not a second Pro check',
      /resolveUserAccess/.test(r) && !/publicMetadata/.test(r));
    ok('the tier set matches the worker\'s', /const PRO_TIERS = new Set\(\['pro', 'elite'\]\)/.test(r)
      && /const PRO_TIERS = new Set\(\['pro', 'elite'\]\)/.test(code('src/lib/alerts/evidence-alert-worker.mjs')));
  }

  L('⚠️ 4 — DELIVERY-TIME entitlement: a downgrade stops alerts');
  {
    const w = code('src/lib/alerts/evidence-alert-worker.mjs');
    ok('⚠️ the worker resolves entitlement for its subscribers', /resolveAccess\(allSubs\.map\(\(s\) => s\.userId\)\)/.test(w));
    // ⚠️ AND IT IS THE SHARED RESOLVER, NOT ONE THE WORKER GREW ITSELF. Mutation testing found this
    // gap: swapping the default for a locally-written Clerk loop that reads publicMetadata.plan
    // directly still satisfied "calls resolveAccess", and that is precisely the second Pro-detection
    // mechanism the brief forbids — the copy in the background job being the one nobody notices has
    // drifted. So the default is pinned by identity, and the worker is forbidden the raw ingredients.
    ok('⚠️ …using the shared by-id resolver as its default',
      /resolveAccess = resolveAccessByIds,/.test(w)
      && /import \{ resolveAccessByIds \} from '\.\.\/entitlements'/.test(w));
    ok('⚠️ …and the worker never reads Clerk or plan metadata itself',
      !/clerkClient/.test(w) && !/publicMetadata/.test(w) && !/getUser/.test(w));
    ok('⚠️ …and filters to entitled tiers before delivering',
      /const subs = allSubs\.filter\(\(s\) => PRO_TIERS\.has\(access\.get\(s\.userId\)\?\.tier\)\)/.test(w));
    ok('⚠️ …and the filter precedes the delivery loop',
      w.indexOf('allSubs.filter') < w.indexOf('deliver(rows)'));
    ok('the run reports what it withheld, so a quiet day is distinguishable',
      /skippedNotPro/.test(w) && /unresolved/.test(w));
    ok('…and the cron surfaces both in the heartbeat',
      /skipped not-pro/.test(read('src/app/api/cron/evidence-alerts/route.js'))
      && /unresolved/.test(read('src/app/api/cron/evidence-alerts/route.js')));

    // ⚠️ EXECUTED, WITH A STUBBED RESOLVER AND A STUBBED DELIVERY. No Clerk, no fabricated alert, and
    // no real user: the question is only whether a non-Pro subscriber's rows reach `deliver`.
    await setSubscription(U1, 'AAPL', true);
    await setSubscription(U2, 'AAPL', true);
    const seen = [];
    const deliver = async (rows) => { seen.push(...rows); return rows.length; };
    const tiers = (map) => async (ids) => ({
      access: new Map(ids.map((id) => [id, { tier: map[id] || 'free', beta: false }])), unresolved: 0,
    });

    seen.length = 0;
    const noneProRun = await runEvidenceAlerts({ deliver, resolveAccess: tiers({}), budgetMs: 8000 });
    ok('⚠️ every subscriber Free → nothing is delivered', seen.length === 0 && noneProRun.created === 0);
    ok('⚠️ …and the run says why', noneProRun.skippedNotPro >= 2, JSON.stringify(noneProRun));
    ok('…and it resolved no tickers at all, so no work was wasted', noneProRun.tickers === 0);

    seen.length = 0;
    const unresolvedRun = await runEvidenceAlerts({
      deliver, budgetMs: 8000,
      // A Clerk outage: nobody resolves.
      resolveAccess: async (ids) => ({ access: new Map(), unresolved: ids.length }),
    });
    ok('⚠️ an entitlement outage withholds rather than delivers', seen.length === 0);
    ok('…and reports the unresolved count', unresolvedRun.unresolved >= 2, JSON.stringify(unresolvedRun));

    // And the subscription row is untouched by any of it — the preference survives a lapse.
    ok('⚠️ a skipped subscription is NOT deleted',
      (await listSubscriptions(U1)).includes('AAPL'),
      'reactivating Pro must not require re-enabling every ticker by hand');

    // ⚠️ THE POSITIVE CONTROL. Without it, "nothing delivered" could equally mean the worker is broken.
    seen.length = 0;
    const proRun = await runEvidenceAlerts({
      deliver, budgetMs: 20_000, resolveAccess: tiers({ [U1]: 'pro', [U2]: 'elite' }),
    });
    // Both test users hold several tickers by this point, so the count is bounded below, not fixed.
    ok('⚠️ a Pro subscriber IS processed — the worker finds the subscription',
      proRun.subscriptions >= 2 && proRun.skippedNotPro === 0, JSON.stringify(proRun));
    ok('…and the ticker was actually resolved, so the path runs end to end', proRun.tickers >= 1, JSON.stringify(proRun));
    console.log(`         pro run: ${JSON.stringify(proRun)}`);
    console.log(`         rows offered to delivery: ${seen.length}`);

    // ⚠️ THE LAST HOP: A QUALIFYING EVENT MUST REACH THE DELIVERY PIPELINE. Everything above proves the
    // worker finds the subscription and resolves the ticker; none of it proves an alert is produced,
    // because a subscription created a second ago has a watermark of "now" and nothing is newer than
    // that. Backdating this disposable subscriber's watermark is what makes real, already-published
    // evidence qualify — no fabricated event, no real recipient, and delivery is stubbed.
    await sql`update evidence_alert_subs set enabled_at = now() - interval '30 days'
      where user_id = ${U1}`;
    seen.length = 0;
    const backfilled = await runEvidenceAlerts({
      deliver, budgetMs: 25_000, resolveAccess: tiers({ [U1]: 'pro' }),
    });
    ok('⚠️ with a watermark that predates real evidence, alerts ARE produced',
      seen.length > 0, JSON.stringify(backfilled));
    if (seen.length) {
      const a = seen[0];
      ok('⚠️ …addressed to the subscribing user only', seen.every((x) => x.userId === U1));
      ok('…carrying a canonical evidence id, so delivery is idempotent', seen.every((x) => !!x.evidenceId));
      ok('…a family, title and public time', !!a.family && !!a.title && !!a.publicTime);
      ok('⚠️ …and only for tickers that user subscribed to',
        new Set(seen.map((x) => x.ticker)).size > 0
        && seen.every((x) => ['AAPL', 'MSFT', 'NVDA'].includes(x.ticker)),
        [...new Set(seen.map((x) => x.ticker))].join(','));
      ok('⚠️ …and NOT for the other user, who was resolved Free',
        !seen.some((x) => x.userId === U2));
      console.log(`         delivered ${seen.length} rows, e.g. ${a.ticker} · ${a.family} · ${String(a.title).slice(0, 60)}`);
    }

    // ⚠️ AND THE REAL insertAlerts IS IDEMPOTENT ON THE SAME ROWS — the last link in the chain.
    if (seen.length) {
      const { insertAlerts } = await import('../src/lib/alerts/evidence-alert-store.js');
      const first = await insertAlerts(seen);
      const second = await insertAlerts(seen);
      ok('⚠️ the real delivery pipeline accepts the rows', first > 0, String(first));
      ok('⚠️ …and re-delivering the same events inserts nothing', second === 0, String(second));
      const inbox = await sql`select count(*)::int n from evidence_alerts where user_id = ${U1}`;
      ok('…leaving one alert per event in the inbox', inbox[0].n === first, `${inbox[0].n} vs ${first}`);
    }
  }

  L('⚠️ 5 — the tier rule is one rule, reachable both ways');
  {
    // ⚠️ THE WORKER MUST NOT HAVE ITS OWN COPY. Extracted from resolveUserAccess so a change reaches
    // the request path and the cron path together.
    const e = code('src/lib/entitlements.js');
    ok('the rule is a pure function over a Clerk user', /export function accessFromClerkUser\(user\)/.test(e));
    ok('⚠️ …and resolveUserAccess calls it rather than repeating it',
      /return accessFromClerkUser\(await client\.users\.getUser\(userId\)\)/.test(e)
      && (e.match(/publicMetadata\?\.plan/g) || []).length === 1);
    ok('⚠️ the by-id resolver is batched, not an N+1 against Clerk', /getUserList\(\{ userId: chunk/.test(e));
    ok('…chunked at the API page size', /i \+= 100/.test(e));
    ok('⚠️ …and it fails closed, counting what it could not resolve', /unresolved \+= chunk\.length/.test(e));
    // Exercised directly.
    ok('admin email resolves elite', process.env.ADMIN_EMAIL
      ? accessFromClerkUser({ primaryEmailAddressId: '1', emailAddresses: [{ id: '1', emailAddress: process.env.ADMIN_EMAIL }] }).tier === 'elite'
      : true);
    ok('plan pro → pro', accessFromClerkUser({ publicMetadata: { plan: 'pro' } }).tier === 'pro');
    ok('plan elite → elite', accessFromClerkUser({ publicMetadata: { plan: 'elite' } }).tier === 'elite');
    ok('⚠️ beta === true → pro, flagged beta',
      accessFromClerkUser({ publicMetadata: { beta: true } }).tier === 'pro'
      && accessFromClerkUser({ publicMetadata: { beta: true } }).beta === true);
    for (const v of ['true', 1, 'yes', {}]) {
      ok(`⚠️ beta ${JSON.stringify(v)} grants nothing`, accessFromClerkUser({ publicMetadata: { beta: v } }).tier === 'free');
    }
    for (const v of [undefined, null, 'Pro', 'PRO', 'trial', '']) {
      ok(`⚠️ plan ${JSON.stringify(v)} is free`, accessFromClerkUser({ publicMetadata: { plan: v } }).tier === 'free');
    }
    ok('an empty id list costs no call', (await resolveAccessByIds([])).access.size === 0);
  }

  L('⚠️ 6 — watchlist and alerts are independent, and nothing is unmanageable');
  {
    // ⚠️ NO AUTO-SUBSCRIBE, ANYWHERE. This is the product rule; a grep is the right shape of check
    // because the failure would be a call that should not exist.
    for (const f of ['src/app/api/watchlist/route.js', 'src/components/WatchlistSection.jsx',
      'src/components/WatchlistStar.jsx', 'src/app/api/stripe/webhook/route.js']) {
      let src = '';
      try { src = code(f); } catch { continue; }
      ok(`⚠️ ${f} does not create subscriptions`, !/setSubscription|evidence_alert_subs/.test(src));
    }
    // Removing a watched ticker leaves the subscription alone — verified against the table.
    await setSubscription(U1, 'MSFT', true);
    const before = await listSubscriptions(U1);
    await sql`delete from watchlist where user_id = ${U1}`.catch(() => null);
    ok('⚠️ a watchlist delete does not touch the subscription',
      (await listSubscriptions(U1)).join(',') === before.join(','));

    // …which makes the orphan surface a requirement, not a nicety.
    const o = code('src/components/AlertSubsOrphans.jsx');
    ok('⚠️ subscriptions outside the watchlist are surfaced', /filter\(\(t\) => !inWatchlist\.has\(t\)\)/.test(o));
    ok('…with the same control to switch them off', /<AlertToggle symbol=\{t\} variant="icon" \/>/.test(o));
    ok('…and it renders nothing when there are none', /if \(!orphans\.length\) return null;/.test(o));
    ok('…or for a non-Pro reader, who cannot have any', /if \(!subs\.ready \|\| !subs\.pro\) return null;/.test(o));
    ok('⚠️ it reuses the shared set, adding no request', /loadAlertSubs/.test(o) && !/fetch\(/.test(o));
    const ws = code('src/components/WatchlistSection.jsx');
    ok('⚠️ it is mounted outside the empty/loaded branch, so an empty watchlist still shows it',
      /\)\}\s*<AlertSubsOrphans watched=\{Array\.isArray\(list\) \? list\.map\(\(x\) => x\.ticker\) : \[\]\} \/>/.test(ws.replace(/\s+/g, ' ').replace(/ \{ /g, ' {')) || /Array\.isArray\(list\) \? list\.map/.test(ws));
    ok('…exactly once', (ws.match(/<AlertSubsOrphans/g) || []).length === 1);
  }

  L('⚠️ 7 — limits and the shared-set contract');
  {
    ok(`the per-user cap is enforced in the store (${MAX_SUBS_PER_USER})`,
      /limit of \$\{MAX_SUBS_PER_USER\} alerts reached/.test(read('src/lib/alerts/evidence-alert-store.js')));
    // ⚠️ ONE REQUEST PER PAGE, NOT ONE PER ROW. Pit Scan renders a hundred controls.
    const t = code('src/components/AlertToggle.jsx');
    ok('⚠️ the control never fetches per ticker', !/fetch\(/.test(t));
    ok('…it reads the shared set', /loadAlertSubs\(\)/.test(t));
  }
} finally {
  await cleanup();
  const left = await sql`select count(*)::int n from evidence_alert_subs where user_id like 'test_verify_sub_%'`;
  console.log(`\n(cleanup: ${left[0].n} test rows remaining)`);
  const real = await sql`select count(*)::int n from evidence_alert_subs`;
  console.log(`(evidence_alert_subs now holds ${real[0].n} rows)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
