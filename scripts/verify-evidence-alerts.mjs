// EVIDENCE ALERTS — notifying watchers about public evidence on names they watch.
//
// ── WHAT THESE ASSERTIONS PROTECT ───────────────────────────────────────────
//
// An alert interrupts a person. The two ways that goes wrong are firing twice for one event, and
// firing for something that is not an event. Both are covered here with fixtures, driven through
// injected seams so nothing touches a database.
//
// Run: node scripts/verify-evidence-alerts.mjs [--mutate=<mode>]

process.env.DATABASE_URL ||= 'postgres://verify:verify@127.0.0.1:1/verify';

import fs from 'node:fs';
const lib = await import('../src/lib/evidence-alert-rules.mjs');
const { alertKey, insiderAccessionKey, alertBody, ALERTABLE_FAMILIES, LOOKBACK_HOURS } = lib;

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const read = (p) => fs.readFileSync(new URL(p, new URL('..', import.meta.url)), 'utf8');

const ACC = '0001104659-26-108935';
const eightK = {
  ticker: 'TELA', family: 'catalyst', type: 'sec_8k_delisting',
  summary: 'Delisting / listing-standard notice', publicTime: '2026-09-18T20:05:35.000Z',
  source: 'sec_8k', sourceId: ACC, evidenceId: `TELA|CATALYST|SEC_8K_DELISTING|${ACC}`,
  url: 'https://sec.gov/x', context: { text: 'First listing notice in four years' },
};
const congress = {
  ticker: 'ALK', family: 'congress', type: 'congress_disclosure',
  summary: 'Julie Johnson disclosed a sell',
  // The real ALK shape: traded 2025-10-21, DISCLOSED 2026-08-06 — a 289-day lag.
  eventTime: '2025-10-21T00:00:00.000Z', publicTime: '2026-08-06T00:00:00.000Z',
  source: 'congress', sourceId: 'cong-99', evidenceId: 'ALK|CONGRESS|DISCLOSURE|cong-99',
  facts: { transactionDate: '2025-10-21', disclosureDate: '2026-08-06' },
};
const insider = {
  ticker: 'TELA', family: 'insider', type: 'insider_officer_buy',
  summary: 'Chief Executive Officer open-market purchase of $186K',
  publicTime: '2026-09-18T00:00:00.000Z',
  source: 'sec_form4', sourceId: '0001456817-26-000015',
  evidenceId: 'TELA|INSIDER|INSIDER_OFFICER_BUY|0001456817-26-000015',
};
const thirteenF = {
  ticker: 'ALK', family: 'institution', type: 'institution_breadth_change',
  summary: 'Institutions holding this stock increased from 434 to 478',
  publicTime: '2026-08-06T00:00:00.000Z', referencePeriod: 'Q2 2026',
  source: 'sec_13f', sourceId: '13f|ALK|2026-06-30',
};

// A fake claim table: the primary key, modelled.
function fakeStore() {
  const seen = new Set();
  return {
    seen,
    claim: async (userId, key) => {
      const k = `${userId}|${key}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
  };
}

L('=== ONE EVENT, ONE ALERT ===');
{
  const store = fakeStore();
  const first = await store.claim('u1', alertKey(eightK));
  const second = await store.claim('u1', alertKey(eightK));
  ok('the first claim on an 8-K succeeds', first === true);
  ok('the same 8-K cannot alert twice',
    mut('doublefire') ? false : second === false);
  // A second pass over the same window is the normal case, not an edge case.
  const third = await store.claim('u1', alertKey({ ...eightK, summary: 'reworded by the engine' }));
  ok('…not even when the summary text changes',
    mut('doublefire') ? false : third === false);
  // Two users watching the same name each get it once.
  ok('a different watcher still gets their own alert',
    (await store.claim('u2', alertKey(eightK))) === true);
  ok('…and only once', (await store.claim('u2', alertKey(eightK))) === false);
}

L('\n=== THE FORM 4 EMAIL AND THE BELL SHARE ONE KEY ===');
{
  // The mailer knows accessions; the engine knows evidence objects. They must collide.
  const store = fakeStore();
  const emailed = await store.claim('u1', insiderAccessionKey(insider.sourceId));
  ok('the mailer claims the accession it sent', emailed === true);
  const bell = await store.claim('u1', alertKey(insider));
  ok('the bell then skips the same filing',
    mut('overlap') ? false : bell === false,
    `${insiderAccessionKey(insider.sourceId)} vs ${alertKey(insider)}`);
  ok('the two keys are literally the same string',
    mut('overlap') ? false : insiderAccessionKey(insider.sourceId) === alertKey(insider));

  // And the reverse order: whichever runs first owns the event.
  const s2 = fakeStore();
  ok('the bell can win the race instead', (await s2.claim('u1', alertKey(insider))) === true);
  ok('…and then the mailer skips it',
    (await s2.claim('u1', insiderAccessionKey(insider.sourceId))) === false);

  // The mailer only claims what it actually sent.
  const route = read('src/app/api/cron/insider-alerts/route.js');
  ok('the mailer claims only on a successful send',
    mut('claimsonfail') ? false : /const ok = await sendEmail\(/.test(route) && /if \(ok\) \{/.test(route));
  ok('…and selects the accession it needs to claim with',
    /accession: insiderTrades\.accession/.test(route));
  ok('…and its bookkeeping cannot fail a send that already happened',
    /catch \{ \/\* bookkeeping must never fail a send/.test(route));
}

L('\n=== CONGRESS USES THE DISCLOSURE DATE ===');
{
  const body = alertBody('ALK', congress);
  ok('the alert reports the disclosure date',
    mut('txdate') ? false : body.includes('2026-08-06'), body);
  ok('…and never the transaction date',
    mut('txdate') ? false : !body.includes('2025-10-21'), body);
  // The engine supplies publicTime; the rules must not reach past it for a different clock.
  // Against the CODE — the file explains the 289-day lag in prose, which is the rule being
  // stated, not a second clock being read.
  const rulesCode = read('src/lib/evidence-alert-rules.mjs')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the alert body reads publicTime and nothing else',
    mut('txdate') ? false
      : /ev\.publicTime/.test(rulesCode) && !/transactionDate|eventTime/.test(rulesCode));
}

L('\n=== WHAT IS WORTH INTERRUPTING SOMEONE FOR ===');
{
  ok('8-K catalysts alert', ALERTABLE_FAMILIES.includes('catalyst'));
  ok('insider filings alert', ALERTABLE_FAMILIES.includes('insider'));
  ok('congress disclosures alert', ALERTABLE_FAMILIES.includes('congress'));
  // ⚠️ 13F IS NOT AN ALERT. A quarterly snapshot disclosed up to 45 days late is context, not an
  // interruption — and it is already on the timeline and in What Changed.
  ok('13F does NOT alert',
    mut('alerts13f') ? false : !ALERTABLE_FAMILIES.includes('institution'));
  ok('…so a 13F event is filtered out before any claim',
    !ALERTABLE_FAMILIES.includes(thirteenF.family));

  // ⚠️ NO PRICE, NO VOLUME, NO RVOL — the alert types removed from the picker stay removed.
  const src = read('src/lib/evidence-alerts.js').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const banned of ['rvol', 'relative volume', 'changePct', 'getQuotes']) {
    ok(`alerts never reach for ${banned}`,
      mut('addsprice') ? false : !new RegExp(banned, 'i').test(src));
  }
}

L('\n=== WATCHED TICKERS ONLY, AND ONLY REAL ONES ===');
{
  const src = read('src/lib/evidence-alerts.js');
  ok('every pass starts from the watchlist',
    mut('universewide') ? false : /from\(watchlist\)/.test(src));
  ok('…and there is no market-wide path', !/screenerStocks|from\(screener/.test(src));
  // ⚠️ INVALID TICKERS NEVER REACH THE ENGINE.
  ok('rows are gated by isIngestableTicker',
    mut('invalidtickers') ? false : /if \(!isIngestableTicker\(r\.ticker\)\) continue;/.test(src));

  // Proven by behaviour, not only by reading: the gate is the shared one.
  const { isIngestableTicker } = await import('../src/lib/security-identity.mjs');
  for (const bad of ['NONE', 'N/A', '', '(CALX)', 'NYSE: VTEX']) {
    ok(`"${bad}" is not a watchable ticker`,
      mut('invalidtickers') ? false : !isIngestableTicker(bad));
  }
  ok('a real symbol still passes', isIngestableTicker('TELA'));
}

L('\n=== THE ALERT SAYS SOMETHING USEFUL ===');
{
  const body = alertBody('TELA', eightK);
  ok('it names the ticker', body.startsWith('TELA:'));
  ok('it says what happened', body.includes('Delisting / listing-standard notice'));
  ok('it says why that is notable', body.includes('First listing notice in four years'));
  ok('it says when it became public', /public 2026-09-18 20:05 UTC/.test(body), body);
  // An event with no context line still reads as a sentence.
  ok('a plain event still reads cleanly', alertBody('ALK', congress).includes('ALK: Julie Johnson disclosed a sell'));
}

L('\n=== NO FIREHOSE ===');
{
  const src = read('src/lib/evidence-alerts.js');
  ok('a single pass is capped', mut('uncapped') ? false : /MAX_ALERTS_PER_RUN/.test(src) && /fired >= limit/.test(src));
  ok('the ticker fan-out is bounded', /MAX_TICKERS/.test(src) && /slice\(0, MAX_TICKERS\)/.test(src));
  ok('resolver concurrency is small', lib.CONCURRENCY <= 6 && lib.CONCURRENCY > 0);
  ok('the look-back is generous, because the key makes overlap free',
    LOOKBACK_HOURS >= 24, `${LOOKBACK_HOURS}h`);
  // The claim IS the dedupe — a primary key, not application logic.
  ok('dedupe is a database primary key',
    mut('softdedupe') ? false : /PRIMARY KEY \(user_id, alert_key\)/.test(src));
  ok('…and the claim is an insert that returns at most once',
    /on conflict \(user_id, alert_key\) do nothing\s*\n?\s*returning alert_key/.test(src));
  ok('nothing is notified unless the claim succeeded',
    mut('notifyfirst') ? false : /if \(!\(await claim\(/.test(src));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
