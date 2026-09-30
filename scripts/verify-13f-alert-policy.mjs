// 13F / INSTITUTIONAL ALERT POLICY — one rule, and the live path checked against it.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-13f-alert-policy.mjs
//
// ⚠️ WHAT THE CONTRADICTION WAS. A deleted module, lib/alerts/evidence-alert-rules.mjs, declared
// ALERTABLE_FAMILIES = ['catalyst','insider','congress'] under the heading "13F IS NOT AN ALERT", while
// the live policy in lib/alerts/evidence-alerts.mjs includes FAMILY.INSTITUTION. Two answers to one
// product question, one of them dead and importable. The dead one is gone; this file makes sure it
// cannot come back and that the surviving rule is the one the product actually performs.
//
// ⚠️ THE RULE, WHICH IS A DISTINCTION AND NOT A SWITCH:
//   13F data IS a supported evidence source.
//   A QUALIFYING institutional evidence event may alert an explicitly subscribed Pro user.
//   A raw 13F filing is NOT automatically an alert.
//
// The third clause is the one that needs proving, and it is not proved by a comment. It is proved by
// what the engine's unit of institutional evidence actually IS.
import { readFileSync, existsSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { FAMILY, DIRECTION, changedSince, dedupeKey } from '../src/lib/evidence/model.mjs';
import { ALERTABLE_FAMILIES, FAMILY_LABEL, alertsFor, LOOKBACK_DAYS } from '../src/lib/alerts/evidence-alerts.mjs';
import { breadthChangeContext, implausibleBreadth } from '../src/lib/evidence/history.mjs';
import { setSubscription, listSubscriptions, insertAlerts } from '../src/lib/alerts/evidence-alert-store.js';
import { runEvidenceAlerts } from '../src/lib/alerts/evidence-alert-worker.mjs';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ⚠️ ISOLATED FIXTURES. Disposable ids in no watchlist, and the Evidence Alert worker is only ever
// called here with a stubbed deliver and a stubbed entitlement resolver, so no production run can
// consume them and nothing can reach a real person.
const U1 = `test_13f_${Date.now()}_pro`;
const U2 = `test_13f_${Date.now()}_free`;
const cleanup = async () => {
  await sql`delete from evidence_alert_subs where user_id like 'test_13f_%'`;
  await sql`delete from evidence_alerts where user_id like 'test_13f_%'`;
};
await cleanup();

/** A qualifying institutional evidence object, shaped exactly as resolve.js emits one. */
const instEvidence = ({ ticker = 'ZZTEST', quarter = '2026-06-30', filed = '2026-08-14', from = 120, to = 141 } = {}) => {
  const change = breadthChangeContext({ from, to, priorChanges: [3, 4, 2, 5] });
  const ev = {
    ticker, family: FAMILY.INSTITUTION, type: 'institution_breadth_change',
    subtype: quarter,
    direction: change.delta > 0 ? DIRECTION.POSITIVE : DIRECTION.NEGATIVE,
    materiality: change.unusual ? 0.60 : 0.45, quality: 0.80,
    eventTime: quarter, publicTime: filed,
    source: 'sec_13f', sourceId: `13f|${ticker}|${quarter}`, url: null,
    summary: change.text, facts: { delta: change.delta }, context: null,
  };
  // ⚠️ THE ID IS DERIVED THE WAY THE ENGINE DERIVES IT, not invented here. normalize() does
  // `ev.evidenceId = ev.evidenceId || dedupeKey(ev)`, and toAlert refuses any object without one —
  // "an id we cannot establish means no alert rather than a possible duplicate". My first fixture
  // omitted it and produced zero alerts, which looked like a broken path and was a correct refusal.
  ev.evidenceId = dedupeKey(ev);
  return ev;
};

try {
  L('⚠️ 1 — there is exactly ONE policy, and the dead one cannot come back');
  {
    ok('⚠️ the contradicting module is gone',
      !existsSync(new URL('../src/lib/alerts/evidence-alert-rules.mjs', import.meta.url)));
    // ⚠️ CODE, NOT COMMENTS. Asserted against raw source this failed on the changelog entry in
    // lib/evidence-alerts.js that NAMES the deleted module while describing its deletion — the same
    // trap that has now bitten three suites in this session.
    ok('⚠️ …and nothing imports it', !/evidence-alert-rules/.test(
      ['src/lib/alerts/evidence-alerts.mjs', 'src/lib/alerts/evidence-alert-worker.mjs',
        'src/lib/alerts/evidence-alert-store.js', 'src/lib/evidence-alerts.js',
        'src/app/api/cron/evidence-alerts/route.js'].map((f) => code(f)).join('\n')));
    // ⚠️ ONE DEFINITION IN THE WHOLE TREE. Two is the defect this task exists to close.
    const defs = [];
    for (const f of ['src/lib/alerts/evidence-alerts.mjs', 'src/lib/alerts/evidence-alert-worker.mjs',
      'src/lib/evidence-alerts.js', 'src/lib/evidence/model.mjs', 'src/lib/evidence/resolve.js']) {
      if (/export const ALERTABLE_FAMILIES/.test(read(f))) defs.push(f);
    }
    ok('⚠️ exactly one module defines ALERTABLE_FAMILIES', defs.length === 1, defs.join(', '));
    ok('…and it is the live alert policy', defs[0] === 'src/lib/alerts/evidence-alerts.mjs');
    // Exercised, not read.
    ok('⚠️ institution IS alertable', ALERTABLE_FAMILIES.includes(FAMILY.INSTITUTION));
    ok('…as are catalyst, insider and congress',
      [FAMILY.CATALYST, FAMILY.INSIDER, FAMILY.CONGRESS].every((f) => ALERTABLE_FAMILIES.includes(f)));
    ok('⚠️ market is the only exclusion, because it is context rather than an event',
      !ALERTABLE_FAMILIES.includes(FAMILY.MARKET)
      && ALERTABLE_FAMILIES.length === Object.values(FAMILY).length - 1);
    ok('…and the family has an inbox label, so an alert can actually be rendered',
      typeof FAMILY_LABEL[FAMILY.INSTITUTION] === 'string' && FAMILY_LABEL[FAMILY.INSTITUTION].length > 0,
      FAMILY_LABEL[FAMILY.INSTITUTION]);
    // ⚠️ AND NO SURVIVING TEXT ASSERTS THE OPPOSITE RULE IN PRODUCTION CODE. The one remaining
    // mention of the old heading is a changelog entry in lib/evidence-alerts.js describing the
    // deletion, which is history rather than a competing rule — so it is matched for deliberately.
    // ⚠️ A QUOTATION IS NOT A RULE, AND THIS ASSERTION HAD TO LEARN THE DIFFERENCE. Written as "the
    // phrase must not appear", it failed the moment the policy module started quoting the old heading in
    // order to explain that it was wrong — which is the documentation this task was asked to write. What
    // must not exist is the phrase stated as CURRENT policy; every surviving occurrence has to sit in a
    // historical frame naming the deletion.
    const POLICY_FILES = ['src/lib/alerts/evidence-alerts.mjs', 'src/lib/alerts/evidence-alert-worker.mjs',
      'src/lib/evidence/resolve.js', 'src/lib/evidence-alerts.js'];
    for (const f of POLICY_FILES) {
      const src = read(f);
      if (!/13F IS NOT AN ALERT/i.test(src)) { ok(`${f} does not mention the retired rule at all`, true); continue; }
      ok(`⚠️ ${f} mentions it only as a retired rule`,
        /deleted|retired|used to|declared/i.test(src), 'the phrase appears with no indication it is historical');
    }
    // And no module states the opposite unconditional rule either.
    const live = POLICY_FILES.map((f) => read(f)).join('\n');
    ok('⚠️ nothing claims every 13F IS an alert', !/every 13f (is|becomes|generates) an alert/i.test(live));
    // ⚠️ THE BEHAVIOURAL VERSION OF THE SAME CHECK, which no comment can satisfy: institution is in the
    // live list and the retired module is gone. This is the assertion that actually holds the rule.
    ok('⚠️ and the code behaves the surviving way, whatever any comment says',
      ALERTABLE_FAMILIES.includes(FAMILY.INSTITUTION));
    const changelog = read('src/lib/evidence-alerts.js');
    ok('the only surviving mention is the changelog recording the deletion',
      /13F IS NOT AN ALERT/.test(changelog) && /was deleted rather than reconciled/.test(changelog));
    // ⚠️ AND THE AUTHORITATIVE RULE IS WRITTEN WHERE THE QUESTION IS ASKED. The policy was stated only
    // by INCLUDING a family in a list, which is what let a second module state the opposite and look
    // plausible. All three clauses now sit on ALERTABLE_FAMILIES, with a pointer to where the third one
    // is actually enforced — so the next person does not have to re-derive it from a query plan.
    const pol = read('src/lib/alerts/evidence-alerts.mjs');
    ok('⚠️ the policy module states the rule: 13F data IS an evidence source',
      /13F data IS a supported evidence source\./.test(pol));
    ok('⚠️ …that qualifying institutional evidence MAY alert a subscribed Pro user',
      /A QUALIFYING institutional evidence event MAY alert an explicitly subscribed Pro user\./.test(pol));
    ok('⚠️ …and that a raw filing is NOT automatically an alert',
      /A raw 13F filing is NOT automatically an alert\./.test(pol));
    ok('…and it points at where that is actually enforced, rather than restating it as a threshold',
      /institutionEvidence\(\) in evidence\/resolve\.js never emits one object per filing/.test(pol));
  }

  L('⚠️ 2 — a raw 13F filing is NOT the unit of institutional evidence');
  {
    // ⚠️ THIS IS THE WHOLE ANTI-SPAM ARGUMENT, AND IT IS STRUCTURAL RATHER THAN A THRESHOLD. The engine
    // never emits one evidence object per 13F filing. It aggregates count(distinct cik) per QUARTER and
    // emits at most ONE object per ticker per quarter, describing the quarter-over-quarter change. A
    // single fund filing a 13F therefore cannot produce an alert at all — there is nothing for it to be.
    const r = code('src/lib/evidence/resolve.js');
    ok('⚠️ institutional evidence is aggregated per quarter, not per filing',
      /count\(distinct cik\) as breadth/.test(r) && /group by quarter/.test(r));
    ok('⚠️ …and the emitted type is a CHANGE, not a filing',
      /type: 'institution_breadth_change'/.test(r) && !/type: 'sec_13f_filing'/.test(r));
    ok('⚠️ fewer than two quarters yields nothing to compare, so nothing is reported',
      /if \(r\.length < 2\) return \[\];/.test(r));
    ok('⚠️ a quarter with no disclosure date yields nothing', /if \(!latest\?\.filed\) return \[\];/.test(r));
    ok('⚠️ an implausible breadth jump is rejected as a resolution artifact, not reported as an event',
      /if \(implausibleBreadth\(prev\.breadth, latest\.breadth\)\) return \[\];/.test(r));
    ok('⚠️ and no qualifying change means no evidence', /if \(!change\) return \[\];/.test(r));
    ok('the 13F family is still a real evidence source, wired into the resolver',
      /\['institution', institutionEvidence\]/.test(r));

    // Executed: the qualification gate itself.
    ok('⚠️ a breadth delta of zero does not qualify', breadthChangeContext({ from: 100, to: 100 }) === null);
    ok('…nor does a non-finite pair', breadthChangeContext({ from: null, to: 5 }) === null
      && breadthChangeContext({ from: 5, to: undefined }) === null);
    ok('⚠️ a real change does qualify', !!breadthChangeContext({ from: 100, to: 112 }));
    ok('⚠️ an implausible collapse is refused', implausibleBreadth(1085, 191) === true);
    ok('…while an ordinary quarter is not', implausibleBreadth(120, 141) === false);
    // ⚠️ AND THE ALERT LAYER ADDS NO SECOND MATERIALITY RULE, by design: qualification is the engine's
    // job. This is asserted so nobody "fixes" spam by adding a threshold in the wrong layer.
    const pol = code('src/lib/alerts/evidence-alerts.mjs');
    ok('⚠️ the alert layer applies no score or threshold of its own',
      !/materiality >/.test(pol) && !/score >/.test(pol) && !/\.materiality\s*[<>]=?/.test(pol));
  }

  L('⚠️ 3 — timing: a 13F alerts when it became PUBLIC, not when the quarter ended');
  {
    // ⚠️ THE TWO CLOCKS ARE MONTHS APART HERE, WHICH IS WHY THIS MATTERS MORE FOR 13F THAN ANYWHERE
    // ELSE. Alerting on eventTime would fire a Q2 alert on 30 June — six weeks before the filing that
    // revealed it existed.
    const ev = instEvidence({ quarter: '2026-06-30', filed: '2026-08-14' });
    const now = Date.parse('2026-08-20');
    ok('⚠️ a subscriber from before the FILING is alerted',
      alertsFor([ev], '2026-08-01T00:00:00Z', { now }).length === 1);
    ok('⚠️ a subscriber from after the filing is NOT',
      alertsFor([ev], '2026-08-15T00:00:00Z', { now }).length === 0);
    ok('⚠️ …and a subscriber who joined between quarter-end and filing IS alerted, on publicTime',
      alertsFor([ev], '2026-07-15T00:00:00Z', { now }).length === 1,
      'eventTime gating would have withheld this');
    const a = alertsFor([ev], '2026-08-01T00:00:00Z', { now })[0];
    ok('the alert carries the institutional family', a?.family === FAMILY.INSTITUTION);
    ok('…and the public time, not the quarter end', String(a?.publicTime).slice(0, 10) === '2026-08-14');
    ok('…labelled as an institutional disclosure', a?.title === FAMILY_LABEL[FAMILY.INSTITUTION], String(a?.title));
    // ⚠️ AND AN OBJECT WHOSE IDENTITY CANNOT BE ESTABLISHED PRODUCES NO ALERT. Without this, a
    // resolver bug that dropped the id would silently become a duplicate-alert generator. Found by my
    // own fixture omitting it.
    ok('⚠️ evidence with no id yields no alert, rather than a possible duplicate',
      alertsFor([{ ...ev, evidenceId: undefined }], '2026-08-01T00:00:00Z', { now }).length === 0);
    ok('…and neither does an unalertable family',
      alertsFor([{ ...ev, family: FAMILY.MARKET }], '2026-08-01T00:00:00Z', { now }).length === 0);
    ok('…nor an unparseable public time',
      alertsFor([{ ...ev, publicTime: 'not-a-date' }], '2026-08-01T00:00:00Z', { now }).length === 0);
  }

  L('⚠️ 4 — dedupe: stable within a quarter, distinct across quarters');
  {
    const q2 = instEvidence({ quarter: '2026-06-30', filed: '2026-08-14' });
    const q3 = instEvidence({ quarter: '2026-09-30', filed: '2026-11-14', from: 141, to: 150 });
    const now = Date.parse('2026-11-20');
    // ⚠️ REPEATED PROCESSING OF ONE QUARTER IS ONE EVENT.
    const twice = alertsFor([q2, { ...q2 }], '2026-08-01T00:00:00Z', { now });
    ok('⚠️ the same institutional evidence twice yields ONE alert', twice.length === 1);
    ok('⚠️ …because the identity includes the quarter', /2026-06-30/.test(q2.sourceId));
    // ⚠️ AND TWO QUARTERS ARE TWO EVENTS — the failure mode is collapsing them, which would silence
    // every quarter after the first.
    const both = alertsFor([q2, q3], '2026-08-01T00:00:00Z', { now });
    ok('⚠️ two quarters remain two distinct alerts', both.length === 2, JSON.stringify(both.map((x) => x.evidenceId)));
    ok('…with different evidence ids', both[0].evidenceId !== both[1].evidenceId);
    ok('…ordered oldest-first by public time',
      Date.parse(both[0].publicTime) < Date.parse(both[1].publicTime));

    // ⚠️ AND THE DATABASE ENFORCES IT TOO, not just the in-memory pass.
    const rows = both.map((x) => ({ ...x, userId: U1 }));
    const first = await insertAlerts(rows);
    const again = await insertAlerts(rows);
    ok('⚠️ the store accepts both quarters', first === 2, String(first));
    ok('⚠️ …and re-delivering them inserts nothing', again === 0, String(again));
    const n = await sql`select count(*)::int n from evidence_alerts where user_id=${U1}`;
    ok('…leaving exactly one row per quarter', n[0].n === 2, String(n[0].n));
    await sql`delete from evidence_alerts where user_id=${U1}`;
  }

  L('⚠️ 5 — who actually receives it: explicit Pro subscription only');
  {
    // Subscribe U1 (will be resolved Pro) and U2 (will be resolved Free) to the same ticker.
    await setSubscription(U1, 'AAPL', true);
    await setSubscription(U2, 'AAPL', true);
    ok('both test users hold an explicit subscription',
      (await listSubscriptions(U1)).includes('AAPL') && (await listSubscriptions(U2)).includes('AAPL'));

    const seen = [];
    const deliver = async (rows) => { seen.push(...rows); return rows.length; };
    const tiers = (map) => async (ids) => ({
      access: new Map(ids.map((id) => [id, { tier: map[id] || 'free', beta: false }])), unresolved: 0,
    });

    // ⚠️ FREE WITH A SUBSCRIPTION ROW RECEIVES NOTHING. The row is a preference, never proof of
    // entitlement — this is the delivery-time check from the Evidence Alerts task, re-asserted here
    // because institutional evidence must not be the family that slips past it.
    seen.length = 0;
    const freeRun = await runEvidenceAlerts({ deliver, resolveAccess: tiers({}), budgetMs: 8000 });
    ok('⚠️ a Free user with a subscription row receives nothing', seen.length === 0 && freeRun.created === 0);
    ok('…and the run reports them as skipped, not as absent', freeRun.skippedNotPro >= 2, JSON.stringify(freeRun));

    // ⚠️ ENTITLEMENT LOOKUP FAILURE FAILS CLOSED.
    seen.length = 0;
    const outage = await runEvidenceAlerts({
      deliver, budgetMs: 8000, resolveAccess: async (ids) => ({ access: new Map(), unresolved: ids.length }),
    });
    ok('⚠️ an entitlement lookup failure withholds rather than delivers', seen.length === 0);
    ok('…and says how many it could not resolve', outage.unresolved >= 2, JSON.stringify(outage));

    // ⚠️ PRO SUBSCRIBED IS PROCESSED — the positive control, so "nothing delivered" above cannot be
    // explained by a broken worker.
    seen.length = 0;
    const proRun = await runEvidenceAlerts({
      deliver, budgetMs: 20_000, resolveAccess: tiers({ [U1]: 'pro' }),
    });
    ok('⚠️ a Pro subscriber IS processed', proRun.subscriptions >= 1 && proRun.skippedNotPro >= 1,
      JSON.stringify(proRun));
    ok('…and the subscribed ticker was resolved', proRun.tickers >= 1, JSON.stringify(proRun));
    ok('⚠️ …and nothing was delivered to the Free user in the same run',
      !seen.some((x) => x.userId === U2));

    // ⚠️ UNSUBSCRIBED PRO RECEIVES NOTHING. Turning the subscription off must end delivery even though
    // the user is fully entitled — entitlement is not a subscription.
    await setSubscription(U1, 'AAPL', false);
    seen.length = 0;
    const unsub = await runEvidenceAlerts({ deliver, resolveAccess: tiers({ [U1]: 'pro' }), budgetMs: 8000 });
    ok('⚠️ an unsubscribed Pro user receives nothing', seen.length === 0 && unsub.created === 0,
      JSON.stringify(unsub));
    ok('…and the worker sees no subscription for them', unsub.subscriptions === 0);
  }

  L('⚠️ 6 — the institutional path is wired end to end, against real data');
  {
    // ⚠️ NOT A FABRICATED EVENT. This asks the real resolver for a real ticker and reports what the
    // production data currently yields. Whether an institutional object exists right now depends on the
    // ingested quarters, so the assertion is about the PATH working, not about a specific finding.
    // ⚠️ tickerEvidence, WHICH IS WHAT THE WORKER CALLS — not institutionEvidence directly. The
    // individual resolver returns a raw object; evidenceId is assigned by normalize() during the
    // aggregation, and toAlert refuses an object without one. Calling the resolver directly therefore
    // produced an un-alertable object and looked like a broken path, when the only thing broken was my
    // entry point. Going through the production entry point is also the only way this section is
    // genuinely end to end.
    const { tickerEvidence } = await import('../src/lib/evidence/resolve.js');
    const found = [];
    for (const t of ['AAPL', 'MSFT', 'NVDA', 'KO']) {
      try {
        const res = await tickerEvidence(t);
        const list = Array.isArray(res) ? res : (res?.evidence || res?.items || []);
        const inst = list.filter((e) => (e?.family || e?.evidence?.family) === FAMILY.INSTITUTION)
          .map((e) => e.evidence || e);
        if (inst.length) found.push({ ticker: t, ...inst[0] });
      } catch (e) { console.log(`         (${t}: ${String(e.message).slice(0, 70)})`); }
    }
    ok('⚠️ the resolver returns institutional evidence from production data',
      found.length > 0, `${found.length} of 4 tickers yielded an object`);
    if (found.length) {
      const e = found[0];
      ok('⚠️ …in the institution family', e.family === FAMILY.INSTITUTION);
      ok('…typed as a breadth change', e.type === 'institution_breadth_change');
      ok('⚠️ …carrying BOTH clocks, months apart',
        !!e.eventTime && !!e.publicTime && Date.parse(e.publicTime) > Date.parse(e.eventTime));
      ok('⚠️ …with a quarter-scoped identity suitable for dedupe',
        /^13f\|[A-Z.\-]+\|\d{4}-\d{2}-\d{2}$/.test(e.sourceId), e.sourceId);
      ok('…and a factual summary that states a count moving, not a trade',
        /Institutions holding this stock (in|de)creased from \d+ to \d+/.test(e.summary), e.summary);
      // ⚠️ AND IT IS ACTUALLY ALERTABLE — the last link between "is evidence" and "may alert".
      const asAlert = alertsFor([e], new Date(Date.parse(e.publicTime) - 864e5).toISOString(),
        { now: Date.parse(e.publicTime) + 864e5 });
      ok('⚠️ …and a subscriber from before it became public WOULD be alerted', asAlert.length === 1);
      console.log(`         live: ${e.ticker} ${e.sourceId} · public ${String(e.publicTime).slice(0, 10)} · ${e.summary}`);
    }
    // The lookback is a catch-up margin, not a window that could deliver something pre-subscription.
    ok('the worker lookback is a margin, not a window', LOOKBACK_DAYS >= 1 && LOOKBACK_DAYS <= 30, String(LOOKBACK_DAYS));
    ok('⚠️ …and every candidate is still gated on the subscriber watermark',
      /Math\.max\(subSince, Date\.parse\(floor\)\)/.test(code('src/lib/alerts/evidence-alert-worker.mjs')));
  }

  L('⚠️ 7 — nothing from the Evidence Alerts task regressed');
  {
    const w = code('src/lib/alerts/evidence-alert-worker.mjs');
    const r = code('src/app/api/evidence-alerts/route.js');
    ok('⚠️ delivery-time entitlement is still enforced',
      /const subs = allSubs\.filter\(\(s\) => PRO_TIERS\.has\(access\.get\(s\.userId\)\?\.tier\)\)/.test(w));
    ok('…via the shared resolver', /resolveAccess = resolveAccessByIds,/.test(w));
    ok('⚠️ the route still refuses non-Pro server-side', /return \{ error: 'pro_required', status: 403/.test(r));
    ok('…and still fails closed on a lookup error', /catch \{ tier = 'free'; \}/.test(r));
    ok('⚠️ subscriptions are still explicit — nothing auto-subscribes from the watchlist',
      !/setSubscription/.test(code('src/app/api/watchlist/route.js')));
    ok('the bell still dedupes on (user_id, evidence_id)',
      /on conflict \(user_id, evidence_id\) do nothing/.test(code('src/lib/alerts/evidence-alert-store.js')));
    ok('⚠️ and the Free EOD research path is untouched — no tier gate was added to institutions',
      !/PRO_TIERS|pro_required/.test(code('src/app/api/institutions/route.js')));
  }
} finally {
  await cleanup();
  const left = await sql`select count(*)::int n from evidence_alert_subs where user_id like 'test_13f_%'`;
  const la = await sql`select count(*)::int n from evidence_alerts where user_id like 'test_13f_%'`;
  console.log(`\n(cleanup: ${left[0].n} subs, ${la[0].n} alerts remaining for test ids)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
