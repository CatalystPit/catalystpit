// FINAL PRODUCTION VERIFICATION FOR THE AUDIT-CLEANUP BATCH.
//
// ⚠️ ONE PASS OVER THE SYSTEMS THIS BATCH REPAIRED, in a real browser plus direct API calls, proving they
// are healthy TOGETHER rather than one at a time. Nothing here fabricates an event, sends a notification,
// throws the licensing stop order, or signs in — the authenticated branches are named at the end as
// untested rather than implied.
//
// ⚠️ EVERY CONTRACT BELOW WAS READ OUT OF THE ROUTE BEFORE IT WAS ASSERTED. Guessing a parameter name is
// how an earlier pass "verified" a filter that the route ignored: /api/dividends/calendar takes
// limit/offset (not pageSize) and caps a window at 120 days, /api/screener takes pageSize/page and a
// `filters` JSON blob, and /api/quotes reports freshness PER SYMBOL rather than at the top level.
import { attach, newTab } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const GATED = ['insiderNet90d', 'insiderBuyers90d', 'insiderBuy90d', 'insiderSell90d',
  'congressNet90d', 'congressBuy90d', 'fundNetQoq', 'consensusScore'];
const RESERVED = /^(Z[A-Z]ZZT|[A-Z]?TEST[A-Z]?|ZXYZ[A-Z]?)$/;

const p = await attach(await newTab());

L('/api/health — the whole batch at once');
let health;
{
  const r = await fetch(`${BASE}/api/health`);
  health = await r.json();
  ok('answers 200', r.status === 200);
  ok('⚠️ overall healthy', health.ok === true && health.status === 'healthy', String(health.status));
  ok('⚠️ nothing failing', (health.failing || []).length === 0, JSON.stringify(health.failing));
  ok('⚠️ no late job', (health.jobs?.late || []).length === 0, JSON.stringify(health.jobs?.late));
  ok('⚠️ no failing job', (health.jobs?.failing || []).length === 0, JSON.stringify(health.jobs?.failing));
  // ⚠️ THE ONLY PERMITTED never-ran ARE THE EVENT-DRIVEN WEBHOOKS, which have no cadence to be late
  // against — a quiet signup week is not an outage.
  ok('…and the only never-ran jobs are the event-driven webhooks',
    JSON.stringify((health.jobs?.neverRan || []).slice().sort()) === '["clerk-webhook","stripe-webhook"]',
    JSON.stringify(health.jobs?.neverRan));
  const job = (n) => (health.jobs?.jobs || []).find((j) => j.job === n);
  for (const n of ['dividends', 'evidence-alerts', 'insider-alerts', 'halts', 'primary-sources',
    'screener', 'institutions', 'institutions-ownership', 'form4']) {
    const j = job(n);
    ok(`${n} is ok with 0 consecutive failures`, j?.state === 'ok' && j?.consecutiveFailures === 0,
      `${j?.state} / ${j?.consecutiveFailures}`);
  }
  const lic = (health.checks || []).find((c) => c.name === 'licensing.realtime');
  ok('⚠️ licensing.realtime names which state is in force',
    ['live', 'stopped', 'off', 'unconfigured'].includes(lic?.state), String(lic?.state));
  ok('…and is ok, so an intentional state is never a red alert', lic?.ok === true);
  console.log(`         licensing.realtime → ${lic?.state} · ${lic?.note}`);
  // ⚠️ SECRETS: /api/health is world-readable. The vendor NAME is public by contract; a credential is not.
  const all = JSON.stringify(health);
  const SECRETISH = /KV_REST|Bearer |[A-Za-z0-9]{32,}|upstash\.io|sk_[a-z]+_|pk_[a-z]+_|invoice|contract|plan_/i;
  ok('⚠️ no credential, token, authenticated URL, plan or contract term in the payload',
    !SECRETISH.test(all), (all.match(SECRETISH) || [])[0] || '');
}

L('DIVIDENDS — Tiingo only, no duplicate pair, distinct date semantics, empty ≠ broken');
{
  const LIMIT = 1000;
  const j = await (await fetch(`${BASE}/api/dividends/calendar?from=2026-10-01&to=2026-10-31&limit=${LIMIT}`)).json();
  ok('the calendar answers with events', (j.events || []).length > 50, `${(j.events || []).length}`);
  ok('⚠️ it is publicly enabled, not the licensing placeholder', j.enabled === true && j.display === 'public',
    `${j.enabled}/${j.display}`);
  ok('…and the count matches the rows it describes', j.events.length === Math.min(j.total, LIMIT),
    `${j.total} total vs ${j.events.length} returned`);
  const k = new Map();
  for (const e of j.events) { const s = `${e.ticker}|${e.exDividendDate}`; k.set(s, (k.get(s) || 0) + 1); }
  const dups = [...k.entries()].filter(([, n]) => n > 1);
  ok('⚠️ zero duplicate (ticker, ex-date) pairs', dups.length === 0, JSON.stringify(dups.slice(0, 4)));
  ok('every type the dropdown offers has rows behind it',
    (j.types || []).length > 0 && j.types.every((t) => t.n > 0), JSON.stringify(j.types));
  // ⚠️ THE FOUR DATES ARE FOUR DIFFERENT FACTS. A fix that copied one into the others would still
  // produce a full-looking calendar, so the distinctness is asserted rather than assumed.
  const withDecl = j.events.filter((e) => e.declarationDate && e.exDividendDate && e.paymentDate);
  ok('declaration/ex/payment are all populated on a real sample', withDecl.length > 20, `${withDecl.length}`);
  ok('⚠️ …and are not one date copied three times',
    withDecl.some((e) => e.declarationDate !== e.exDividendDate && e.exDividendDate !== e.paymentDate));
  const ordered = withDecl.filter((e) => e.declarationDate <= e.exDividendDate && e.exDividendDate <= e.paymentDate);
  ok('⚠️ declaration ≤ ex ≤ payment on substantially every row',
    ordered.length / withDecl.length > 0.97, `${ordered.length}/${withDecl.length}`);
  // ⚠️ A BROKEN READ MUST NOT LOOK LIKE AN EMPTY PERIOD, and a quiet period must not look broken.
  const bad = await fetch(`${BASE}/api/dividends/calendar?from=2026-01-01&to=2026-12-31`);
  ok('⚠️ an over-wide range is an explicit error, not an empty success', bad.status === 400, String(bad.status));
  const dj = await bad.json();
  ok('…and leaks no infrastructure detail', !/postgres|neon|select |insert |at Object\./i.test(JSON.stringify(dj)),
    JSON.stringify(dj));
  const empty = await (await fetch(`${BASE}/api/dividends/calendar?from=2027-01-28&to=2027-01-29&limit=50`)).json();
  ok('⚠️ a genuinely quiet window is a success with no error flag',
    empty.enabled === true && !empty.error && Array.isArray(empty.events), JSON.stringify(empty).slice(0, 90));
  console.log(`         October: ${j.total} events · source ${j.source} · asOf ${j.asOf}`);
}

L('EVIDENCE ALERTS + FORM 4 — the server refusals, from outside');
{
  for (const body of [{ ticker: 'AAPL' }, { ticker: 'AAPL', enabled: true }]) {
    const r = await fetch(`${BASE}/api/evidence-alerts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    ok(`⚠️ an anonymous subscribe attempt is refused (${JSON.stringify(body)})`,
      r.status === 401 && j.error === 'unauthorized', `${r.status} ${JSON.stringify(j)}`);
  }
  const g = await fetch(`${BASE}/api/evidence-alerts`);
  const gj = await g.json();
  ok('GET is pro:false with no tickers for anonymous',
    g.status === 200 && gj.pro === false && (gj.tickers || []).length === 0, JSON.stringify(gj));
  ok('⚠️ …and it leaks nobody else\'s subscriptions', JSON.stringify(gj.tickers) === '[]');
  // Delivery is cron-side; its health is the heartbeat. ⚠️ NOTHING IS SENT FROM HERE.
  const ea = (health.jobs?.jobs || []).find((j) => j.job === 'evidence-alerts');
  const ia = (health.jobs?.jobs || []).find((j) => j.job === 'insider-alerts');
  ok('⚠️ the Evidence Alert worker ran recently and reports its entitlement accounting',
    ea?.state === 'ok' && /pro subs/.test(String(ea?.note)), String(ea?.note));
  ok('⚠️ the Form 4 mailer is healthy', ia?.state === 'ok', String(ia?.note));
  console.log(`         evidence-alerts: ${ea?.note}\n         insider-alerts:  ${ia?.note}`);
}

L('13F — institutional evidence is live, and it is not one-per-filing');
{
  const j = await (await fetch(`${BASE}/api/evidence?ticker=AAPL`)).json();
  const inst = (j.evidence || []).filter((e) => e.family === 'institution');
  ok('⚠️ the institution family is served as evidence', inst.length > 0, `${inst.length}`);
  const e = inst[0] || {};
  ok('⚠️ …as a quarter-over-quarter CHANGE, not a filing', e.type === 'institution_breadth_change', String(e.type));
  ok('⚠️ …with a quarter-scoped identity, so quarters cannot collapse',
    /^13f\|[A-Z.\-]+\|\d{4}-\d{2}-\d{2}$/.test(String(e.sourceId)), String(e.sourceId));
  // ⚠️ THE TWO CLOCKS. A 13F is public ~6 weeks after the quarter it describes; alert timing runs on
  // publicTime alone, so the gap must be present in the data rather than assumed by the worker.
  const gapDays = (Date.parse(e.publicTime) - Date.parse(e.eventTime)) / 86_400_000;
  ok('⚠️ publicTime is well after eventTime', gapDays > 20, `${Math.round(gapDays)} days`);
  // ⚠️ THE POLICY ITSELF: qualification is RECORDED ON THE ROW. "Every 13F row is an alert" is not
  // merely discouraged — the evidence carries an explicit unusual/basis judgement to gate on.
  ok('⚠️ the row carries an explicit unusual judgement', typeof e.facts?.unusual === 'boolean',
    JSON.stringify(e.facts?.unusual));
  ok('…and names the basis for it', typeof e.facts?.basis === 'string' && e.facts.basis.length > 3,
    String(e.facts?.basis));
  ok('…over a stated reference period', /^Q[1-4] \d{4}$/.test(String(e.referencePeriod)), String(e.referencePeriod));
  ok('⚠️ no evidence family failed', (j.failedFamilies || []).length === 0, JSON.stringify(j.failedFamilies));
  const instCheck = (health.checks || []).find((c) => c.name === 'freshness.institutions');
  ok('⚠️ institutional freshness is sane', instCheck?.ok === true, JSON.stringify(instCheck));
  console.log(`         ${e.sourceId} · unusual=${e.facts?.unusual} basis=${e.facts?.basis} · "${e.summary}"`);
}

L('HALTS — durable without a Terminal, and an empty feed is a success');
{
  const h = (health.jobs?.jobs || []).find((j) => j.job === 'halts');
  ok('⚠️ the halts heartbeat exists', !!h);
  ok('⚠️ …is ok with a recent success', h?.state === 'ok' && h.ageHours <= 2, `${h?.ageHours}h`);
  // ⚠️ FAILURE ISOLATION: halts report separately from the wire they ride on, so a wire problem and a
  // halt problem cannot hide inside one opaque heartbeat.
  ok('⚠️ …separate from the primary-sources wire it rides',
    h?.job === 'halts' && !!(health.jobs?.jobs || []).find((j) => j.job === 'primary-sources'));
  // ⚠️ fetched N · projected 0 IS THE PROOF THAT AN EMPTY PROJECTION IS A SUCCESS: the feed answered,
  // nothing was new, and the run is green.
  ok('⚠️ a run that projected nothing is still a success',
    /fetched \d+ · projected \d+/.test(String(h?.note)) && h?.state === 'ok', String(h?.note));
  // The Terminal-facing route must still work as a supplement, without being required for durability.
  const r = await fetch(`${BASE}/api/halts`);
  const j = await r.json().catch(() => ({}));
  ok('⚠️ the supplemental /api/halts path still answers', r.status === 200 && Array.isArray(j.halts),
    `${r.status}`);
  ok('…and reports its own asOf', !!j.asOf);
  console.log(`         heartbeat: ${h?.note} · /api/halts: ${j.halts?.length} listed, asOf ${j.asOf}`);
}

L('SCREENER — universe, test symbols, and the aggregate gate');
{
  const first = await (await fetch(`${BASE}/api/screener?pageSize=100`)).json();
  ok('the board answers', (first.rows || []).length === 100, `${first.rows?.length}`);
  ok('⚠️ an anonymous caller is told pro:false', first.pro === false, String(first.pro));
  // ⚠️ THE UNIVERSE MOVES WITH THE NIGHTLY REBUILD. 18,036 was a measurement, not a constant; what must
  // hold is that it is plausible and that the exclusion still applies at whatever the new count is.
  ok('⚠️ the universe is plausibly sized', first.total > 15_000 && first.total < 30_000, String(first.total));
  const sweep = [];
  for (let pg = 0; pg < 20; pg++) {
    const r = await (await fetch(`${BASE}/api/screener?pageSize=100&page=${pg}`)).json();
    if (!(r.rows || []).length) break;
    sweep.push(...r.rows.map((x) => String(x.ticker).toUpperCase()));
  }
  ok('a 2,000-row sweep returned rows', sweep.length > 1500, `${sweep.length}`);
  ok('…and the sweep did not just repeat page 0', new Set(sweep).size === sweep.length,
    `${new Set(sweep).size} unique of ${sweep.length}`);
  const res = sweep.filter((t) => RESERVED.test(t));
  ok('⚠️ no exchange test symbol in the sweep', res.every((t) => t === 'TEST'), JSON.stringify([...new Set(res)]));
  const real = await (await fetch(`${BASE}/api/screener?ticker=TEST&pageSize=10`)).json();
  ok('⚠️ the legitimate TEST ETF is still served',
    (real.rows || []).some((x) => String(x.ticker).toUpperCase() === 'TEST'));
  // Aggregate gating, three ways: the cell, the filter and the ordering.
  ok('⚠️ no gated field reaches an anonymous caller',
    GATED.every((k) => !first.rows.some((r) => k in r)),
    JSON.stringify(GATED.filter((k) => first.rows.some((r) => k in r))));
  const F = (o) => `${BASE}/api/screener?pageSize=5&filters=${encodeURIComponent(JSON.stringify(o))}`;
  // ⚠️ THE CONTROL COMES FIRST. If the filter syntax were wrong, the gated filter would be "dropped"
  // only because the route ignored it — a false pass. hasMaterial8k is the same boolean shape and is
  // deliberately NOT gated, so it must narrow the set.
  const ctrl = await (await fetch(F({ hasMaterial8k: { eq: true } }))).json();
  ok('⚠️ control: an ungated boolean filter of the same shape really narrows the set',
    ctrl.droppedFilters === undefined && ctrl.total > 0 && ctrl.total < first.total,
    `${ctrl.total} of ${first.total}`);
  const filt = await (await fetch(F({ insiderBuy90d: { eq: true } }))).json();
  ok('⚠️ a gated filter is dropped, declared, and does not narrow',
    JSON.stringify(filt.droppedFilters) === '["insiderBuy90d"]' && filt.total === first.total,
    `${JSON.stringify(filt.droppedFilters)} total ${filt.total}`);
  const srt = await (await fetch(`${BASE}/api/screener?pageSize=5&sort=insiderNet90d&dir=desc`)).json();
  ok('⚠️ a gated sort is refused', srt.sortRefused === true, JSON.stringify(srt.sortRefused));
  ok('…and the refused sort still returns no gated field',
    (srt.rows || []).every((r) => GATED.every((k) => !(k in r))));
  const r2 = await fetch(`${BASE}/api/screener?pageSize=5`);
  ok('⚠️ the tier-specific response is private and uncached',
    r2.headers.get('cache-control') === 'private, no-store', String(r2.headers.get('cache-control')));
  // Basic usability must survive all of that.
  const sorted = await (await fetch(`${BASE}/api/screener?pageSize=20&sort=marketCap&dir=desc`)).json();
  const caps = sorted.rows.map((x) => Number(x.marketCap)).filter(Number.isFinite);
  ok('sorting still works, is genuinely ordered, and does not lead with nulls',
    caps.length === sorted.rows.length && caps.every((v, i) => i === 0 || caps[i - 1] >= v), `${caps.length}/20`);
  console.log(`         universe ${first.total} · swept ${sweep.length} · reserved ${JSON.stringify([...new Set(res)])}`);
}

L('PIT SCAN + #11 — labels, taps and the What Changed section, 390px and desktop');
{
  for (const w of [390, 1440]) {
    const mobile = w === 390;
    await p.viewport(w, mobile ? 800 : 900, mobile);
    await p.goto(`${BASE}/scan`, { settleMs: 2000, ceilingMs: 35_000 });
    await new Promise((r) => setTimeout(r, 4000));
    const v = await p.eval(`(() => {
      const txt = document.body.innerText;
      const mk = (cls, inline) => { const b = document.createElement('button'); b.className = cls;
        b.textContent = 'Board'; Object.assign(b.style, inline); document.body.appendChild(b);
        const h = Math.round(b.getBoundingClientRect().height); b.remove(); return h; };
      return {
        // ⚠️ A BARE REAL-TIME CLAIM IS THE DEFECT. "REAL-TIME · PARTIAL" and the delayed/close labels
        // are the corrected wording, so the match deliberately excludes the qualified form.
        falseRealtime: /REAL-TIME(?! · PARTIAL)/.test(txt),
        feedLabel: (txt.match(/REAL-TIME · PARTIAL|REAL-TIME|DELAYED|LAST CLOSE/) || [])[0] || null,
        pill: mk('cp-tap-pill', { fontSize: '11px', padding: '4px 10px', border: '1px solid #ccc' }),
        pillBefore: mk('', { fontSize: '11px', padding: '4px 10px', border: '1px solid #ccc' }),
        act: mk('cp-scan-act', { fontSize: '10.5px', padding: '0', border: 'none' }),
        overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        chars: txt.length
      };
    })()`);
    ok(`${w}px ⚠️ no bare REAL-TIME claim for an anonymous visitor`, v.falseRealtime === false,
      String(v.feedLabel));
    ok(`${w}px the page renders`, v.chars > 300, `${v.chars}`);
    ok(`${w}px ⚠️ no horizontal overflow`, v.overflow <= 1, `${v.overflow}px`);
    if (mobile) {
      ok(`${w}px ⚠️ the untagged pill really was too small`, v.pillBefore <= 24, `${v.pillBefore}px`);
      ok(`${w}px ⚠️ pill tap target is comfortable`, v.pill >= 36, `${v.pill}px (was ${v.pillBefore}px)`);
      ok(`${w}px ⚠️ bare action survives an inline padding:0`, v.act >= 30, `${v.act}px`);
    } else {
      ok('desktop ⚠️ the mobile tap rule does not apply', v.pill <= 26, `${v.pill}px`);
    }
    console.log(`         ${w}px feed=${v.feedLabel} pill=${v.pillBefore}→${v.pill}px act=${v.act}px overflow=${v.overflow}px`);
  }
  // #11 — the What Changed section is signed-in-only by design; it must not leak to a logged-out
  // visitor at either width, and the page must not break in its absence.
  for (const w of [390, 1440]) {
    await p.viewport(w, w === 390 ? 800 : 900, w === 390);
    await p.goto(`${BASE}/watchlist`, { settleMs: 2000, ceilingMs: 30_000 });
    await new Promise((r) => setTimeout(r, 3500));
    const v = await p.eval(`(() => ({
      whatChanged: (document.body.innerText.match(/WHAT CHANGED/g) || []).length,
      markSeen: /Mark seen/.test(document.body.innerText),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      broken: /(something went wrong|unavailable right now|could not load|unexpected error)/i.test(document.body.innerText),
      chars: document.body.innerText.length
    }))()`);
    ok(`${w}px ⚠️ What Changed is absent for a logged-out visitor`, v.whatChanged === 0, `${v.whatChanged}`);
    ok(`${w}px …and so is its Mark seen control`, v.markSeen === false);
    ok(`${w}px the watchlist page renders and is not broken`, v.chars > 300 && v.broken === false,
      `${v.chars} chars, broken=${v.broken}`);
    ok(`${w}px no horizontal overflow`, v.overflow <= 1, `${v.overflow}px`);
  }
}

L('ADS / CSP + legal copy — previous work intact');
{
  const homeRes = await fetch(`${BASE}/`);
  const html = await homeRes.text();
  ok('⚠️ the AdSense loader is NOT server-rendered into the document', !/adsbygoogle\.js/.test(html));
  ok('⚠️ …while ownership is still asserted',
    /<meta name="google-adsense-account" content="ca-pub-/.test(html));
  const csp = homeRes.headers.get('content-security-policy') || '';
  for (const host of ['pagead2.googlesyndication.com', 'ep2.adtrafficquality.google',
    'googleads.g.doubleclick.net', 'www.google.com/recaptcha/', 'ep1.adtrafficquality.google']) {
    ok(`CSP still permits ${host}`, csp.includes(host));
  }
  ok('⚠️ no wildcard ad host was introduced',
    !/https:\/\/\*\.(googlesyndication|doubleclick|adtrafficquality)/.test(csp));
  ok('⚠️ unsafe-eval is still a single pre-existing occurrence', (csp.match(/'unsafe-eval'/g) || []).length === 1);
  ok('…and the Ably realtime endpoint survives', /ably/.test(csp));
  // A real browser must report no violation.
  await p.viewport(1440, 900, false);
  await p.goto(`${BASE}/`, { settleMs: 2200, ceilingMs: 35_000 });
  await new Promise((r) => setTimeout(r, 8000));
  const viol = p.collected.consoleErrors.filter((e) => /Content Security Policy directive/i.test(e));
  ok('⚠️ a real browser reports ZERO CSP violations', viol.length === 0,
    viol.slice(0, 2).map((v) => String(v).slice(0, 110)).join(' | '));
  const ads = await p.eval(`(() => {
    const big = (e) => { const b = e.getBoundingClientRect(); return b.width > 20 && b.height > 20; };
    const frames = [...document.querySelectorAll('iframe')].filter((x) => /aswift|google_ads/i.test(x.id + ' ' + (x.src || '')));
    const slots = [...document.querySelectorAll('ins.adsbygoogle')];
    return { loaderScripts: [...document.scripts].filter((s) => /adsbygoogle/.test(s.src || '')).length,
      visibleFrames: frames.filter(big).length, visibleSlots: slots.filter(big).length,
      statuses: slots.map((e) => e.getAttribute('data-ad-status')) };
  })()`);
  ok('⚠️ the loader is injected client-side exactly once for an eligible visitor',
    ads.loaderScripts === 1, JSON.stringify(ads));
  ok('⚠️ and no ad is actually rendered yet', ads.visibleFrames === 0 && ads.visibleSlots === 0,
    JSON.stringify(ads));
  // Legal copy.
  const terms = (await (await fetch(`${BASE}/terms`)).text()).replace(/\s+/g, ' ');
  ok('⚠️ the durable advertising sentence is still published',
    terms.includes('The Service may display advertising provided by third-party advertising partners, including Google AdSense'));
  ok('…and the retired claim has not returned',
    !/do not display advertising on the Service at this time/i.test(terms));
}

L('TIINGO LICENSING — the single answer, server-side, no secrets');
{
  const r = await fetch(`${BASE}/api/screener?meta=1`);
  const m = await r.json();
  ok('⚠️ an anonymous caller is not told realtime', m.capabilities?.quoteFreshness !== 'realtime',
    String(m.capabilities?.quoteFreshness));
  ok('⚠️ …and is told something definite rather than nothing', !!m.capabilities?.quoteFreshness,
    JSON.stringify(m.capabilities));
  ok('⚠️ no provider id or plan is shipped in the capability payload',
    !/tiingo|provider|plan/i.test(JSON.stringify(m.capabilities || {})), JSON.stringify(m.capabilities));
  ok('…and the entitlement-dependent payload is not publicly cached',
    r.headers.get('cache-control') === 'private, no-store', String(r.headers.get('cache-control')));
  // ⚠️ FRESHNESS IS REPORTED PER SYMBOL, NOT AT THE TOP LEVEL. An earlier assertion read q.freshness,
  // which is undefined on this route — it could never have failed and so proved nothing.
  const q = await (await fetch(`${BASE}/api/quotes?symbols=AAPL,MSFT`)).json();
  const syms = Object.values(q);
  ok('⚠️ /api/quotes answers with quotes', syms.length === 2, `${syms.length}`);
  ok('⚠️ every quote states its own freshness', syms.length > 0 && syms.every((s) => !!s.freshness),
    JSON.stringify(syms.map((s) => s.freshness)));
  ok('⚠️ …and none claims realtime for an anonymous caller',
    syms.length > 0 && syms.every((s) => s.freshness !== 'realtime'),
    JSON.stringify(syms.map((s) => s.freshness)));
  ok('⚠️ no vendor id rides along on a quote', syms.every((s) => !('provider' in s)));
  ok('…and no credential appears in the payload', !/[A-Za-z0-9]{32,}/.test(JSON.stringify(q)));
  console.log(`         anonymous quoteFreshness=${m.capabilities?.quoteFreshness} · quote freshness=${syms.map((s) => s.freshness).join(',')}`);
  // ⚠️ THE STOPPED BRANCH IS NOT EXERCISED HERE ON PURPOSE — throwing the production stop order to test
  // it would withhold real-time from paying subscribers. It is covered by executed assertions.
  console.log('         stopped-state branch: NOT exercised in production, by design — see verify-items-8-9-10.mjs');
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('\nNOT LIVE-TESTED — requires credentials or an owner action I will not take:');
console.log('  · a FREE signed-in session on any of these surfaces');
console.log('  · a PRO session: Pit Scan REAL-TIME labels, the Pro Screener aggregate, Evidence Alert');
console.log('    subscribe/unsubscribe, the What Changed section rendering, Pro ad-free on a real board');
console.log('  · the licensing stop order ACTIVE in production (would withhold real-time from subscribers)');
console.log('  · sending a Form 4 email or delivering an Evidence Alert to a real recipient');
console.log('  All are covered by executed assertions in the suites listed in the report.');
p.close();
process.exit(fail ? 1 : 0);
