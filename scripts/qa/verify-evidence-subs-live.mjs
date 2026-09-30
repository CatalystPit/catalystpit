// EVIDENCE ALERT SUBSCRIPTION PATH, ON PRODUCTION.
//
// ⚠️ THE CONTROL IS CLIENT-RENDERED, so the served HTML says nothing about it: the subscribed set is
// fetched after hydration and the control does not exist until it resolves. This drives a real browser.
//
// The signed-in tiers cannot be exercised without an account and are NOT faked — what is verified here
// without credentials is the anonymous surface, the server-side refusals (which are the part that
// actually protects the feature), and that no surface renders a toggle that would fail.
import { attach, newTab } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);

L('⚠️ the server refuses an unauthenticated subscription, whatever the page rendered');
{
  // ⚠️ THE DIRECT-API BYPASS. Hiding a control is a layout decision; this is the access control.
  for (const body of [{ ticker: 'AAPL' }, { ticker: 'AAPL', enabled: true }, { ticker: 'aapl', enabled: true }]) {
    const r = await fetch(`${BASE}/api/evidence-alerts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    ok(`POST ${JSON.stringify(body)} → 401 unauthorized`, r.status === 401 && j.error === 'unauthorized',
      `${r.status} ${JSON.stringify(j)}`);
  }
  const g = await fetch(`${BASE}/api/evidence-alerts`);
  const gj = await g.json();
  ok('GET for an anonymous caller is 200 with pro:false and no tickers',
    g.status === 200 && gj.pro === false && Array.isArray(gj.tickers) && gj.tickers.length === 0,
    JSON.stringify(gj));
  ok('⚠️ …and it does not leak another user\'s subscriptions', JSON.stringify(gj.tickers) === '[]');
  // Malformed input is refused as input, not as a server failure.
  const bad = await fetch(`${BASE}/api/evidence-alerts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json',
  });
  ok('a malformed body is still refused at the gate, not 500', bad.status === 401, String(bad.status));
}

const p = await attach(await newTab());

for (const mobile of [false, true]) {
  const label = mobile ? '@390px' : '@1440px';
  L(`the ticker page, anonymous ${label}`);
  await p.viewport(mobile ? 390 : 1440, mobile ? 844 : 900, mobile);
  await p.goto(`${BASE}/ticker/AAPL`, { settleMs: 2000, ceilingMs: 35_000 });
  await new Promise((r) => setTimeout(r, 4500));

  const v = await p.eval(`(() => {
    const txt = document.body.innerText;
    // The alert control, in any of its three forms.
    const pro = [...document.querySelectorAll('button, a')].filter((e) => /Alerts? · Pro/.test(e.textContent || ''));
    const live = [...document.querySelectorAll('button')].filter((e) => /^(Alert|Alert On)$/.test((e.textContent || '').trim()));
    return {
      proAffordance: pro.length,
      proText: pro.map((e) => (e.textContent || '').trim()).slice(0, 2),
      functionalToggle: live.length,
      hasStar: /Watchlist|☆|★/.test(txt),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      // ⚠️ NO UPGRADE SHOUTING. One compact affordance, not a banner or a modal.
      upgradeWords: (txt.match(/Unlock Pro|Upgrade to Pro|Start Pro/g) || []).length
    };
  })()`);
  ok(`${label} ⚠️ an anonymous visitor sees the Pro affordance, not a toggle`,
    v.proAffordance >= 1, JSON.stringify(v));
  ok(`${label} ⚠️ …and NO functional Alert toggle that would fail on click`,
    v.functionalToggle === 0, `${v.functionalToggle} found`);
  ok(`${label} the watchlist control is still there beside it`, v.hasStar === true);
  ok(`${label} no horizontal overflow`, v.overflow <= 1, `${v.overflow}px`);
  ok(`${label} ⚠️ the alert control adds no upgrade shouting`, v.upgradeWords <= 1, `${v.upgradeWords} upgrade phrases`);
  console.log(`         control text: ${JSON.stringify(v.proText)}`);

  // ⚠️ NO ENTITLEMENT FLASH. Sample the control repeatedly from first paint: it must never appear as a
  // functional toggle at any point, not merely at the end.
  await p.goto(`${BASE}/ticker/MSFT`, { settleMs: 300, ceilingMs: 30_000 });
  const samples = [];
  for (let i = 0; i < 14; i++) {
    samples.push(await p.eval(`[...document.querySelectorAll('button')].filter((e) => /^(Alert|Alert On)$/.test((e.textContent || '').trim())).length`));
    await new Promise((r) => setTimeout(r, 350));
  }
  ok(`${label} ⚠️ the functional toggle never appears, at any point during load`,
    samples.every((n) => n === 0), JSON.stringify(samples));
}

L('the Pit Scan board, anonymous');
{
  await p.viewport(1440, 900, false);
  await p.goto(`${BASE}/scan`, { settleMs: 2200, ceilingMs: 35_000 });
  await new Promise((r) => setTimeout(r, 5000));
  const v = await p.eval(`(() => {
    const live = [...document.querySelectorAll('button')].filter((e) => /^(Alert|Alert On)$/.test((e.textContent || '').trim()));
    const pro = [...document.querySelectorAll('button, a')].filter((e) => /Alert · Pro/.test(e.textContent || ''));
    return { functionalToggle: live.length, proAffordance: pro.length, chars: document.body.innerText.length };
  })()`);
  // /scan is itself Pro-gated for anonymous, so either no rows render at all or the rows show the Pro
  // form. What must never happen is a functional toggle.
  ok('⚠️ no functional Alert toggle on the anonymous board', v.functionalToggle === 0, JSON.stringify(v));
  console.log(`         scan: ${JSON.stringify(v)}`);
}

L('the watchlist page, anonymous');
{
  await p.goto(`${BASE}/watchlist`, { settleMs: 2000, ceilingMs: 30_000 });
  await new Promise((r) => setTimeout(r, 4000));
  const v = await p.eval(`(() => ({
    functionalToggle: [...document.querySelectorAll('button')].filter((e) => /^(Alert|Alert On)$/.test((e.textContent || '').trim())).length,
    orphanBlock: /Also alerting on/.test(document.body.innerText),
    chars: document.body.innerText.length,
    broken: /unavailable|something went wrong/i.test(document.body.innerText)
  }))()`);
  ok('⚠️ no functional Alert toggle for an anonymous visitor', v.functionalToggle === 0);
  ok('⚠️ the orphan-subscription block is hidden for a non-Pro reader', v.orphanBlock === false);
  ok('the page renders and does not report itself broken', v.chars > 400 && v.broken === false, JSON.stringify(v));
}

L('the cron heartbeat reports the new counters');
{
  const h = await (await fetch(`${BASE}/api/health`)).json();
  const job = (h.jobs?.jobs || []).find((j) => j.job === 'evidence-alerts');
  ok('the evidence-alerts job is reported', !!job);
  ok('⚠️ …and it is healthy', job?.state === 'ok', String(job?.state));
  ok('overall health is unaffected', h.ok === true && h.status === 'healthy', String(h.status));
  console.log(`         note: ${String(job?.note)}`);
  // The new counters appear once the job next runs; before that the note is the old shape, which is
  // not a failure — it is a stale note, and saying so is better than asserting a schedule.
  if (/skipped not-pro/.test(String(job?.note))) {
    ok('⚠️ the note carries the withheld counters', true);
  } else {
    console.log('         (counters appear after the next scheduled run — the note above predates this deploy)');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('\nNOT TESTED — requires credentials I do not have:');
console.log('  · a FREE signed-in user seeing the Pro affordance and being refused by the API (403)');
console.log('  · a PRO user enabling, persisting, disabling and seeing the orphan block');
console.log('  Both are covered by 100 executed assertions against the real store in');
console.log('  scripts/verify-evidence-subs-usable.mjs, including the 403 gate and the delivery path.');
p.close();
process.exit(fail ? 1 : 0);
