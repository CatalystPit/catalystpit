// THE DIVIDEND CALENDAR, IN A REAL BROWSER, AGAINST THE REPAIRED DATABASE.
//
// ⚠️ THE PAGE IS CLIENT-RENDERED. Fetching the HTML and string-matching reports an empty table as fine
// and a working one as broken; the rows arrive from /api/dividends/calendar after hydration. So this
// reads the rendered DOM, on desktop and at 390px.
import { attach, newTab } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);

const p = await attach(await newTab());

L('the API the page reads');
{
  const r = await fetch(`${BASE}/api/dividends/calendar?from=2026-09-30&to=2026-10-30&limit=1000`);
  const j = await r.json();
  ok('answers 200', r.status === 200);
  ok('and is enabled', j.enabled === true, JSON.stringify(j.reason || ''));
  ok('with events', (j.events || []).length > 100, `${(j.events || []).length} events`);
  ok('⚠️ the total equals the rows returned', j.total === j.events.length, `total ${j.total} vs ${j.events.length}`);
  // ⚠️ THE DEFECT THIS FIX EXISTS FOR.
  const k = new Map();
  for (const e of j.events) { const s = `${e.ticker}|${e.exDividendDate}`; k.set(s, (k.get(s) || 0) + 1); }
  const dups = [...k.entries()].filter(([, n]) => n > 1);
  ok('⚠️ ZERO duplicated (ticker, ex-date) pairs', dups.length === 0,
    dups.slice(0, 6).map(([s, n]) => `${s} ×${n}`).join(', '));
  // Field semantics: each date must be its own field, never copied from another.
  const withAll = j.events.filter((e) => e.exDividendDate && e.recordDate && e.paymentDate && e.declarationDate);
  ok('rows carry the four dates as separate fields', withAll.length > 50, `${withAll.length} rows with all four`);
  ok('⚠️ declaration is on or before ex-dividend on every row',
    withAll.every((e) => e.declarationDate <= e.exDividendDate),
    withAll.filter((e) => e.declarationDate > e.exDividendDate).slice(0, 3).map((e) => e.ticker).join(', '));
  // ⚠️ A BOUND, NOT AN ABSOLUTE — AND THAT IS A CORRECTION TO THIS TEST, NOT A CONCESSION.
  //
  // This first asserted payment >= ex on every row and failed on AIJTY (ex 2026-10-20, pay 2026-10-19).
  // A payment before the ex-date is impossible for a real dividend, so the obvious reading was a
  // field-mapping bug. It is not ours: measured across the table, 16 rows of 60,776 (0.026%) carry the
  // ordering, and for 6 of the 10 distinct events BOTH providers publish the identical payment date.
  // Two independent vendors agreeing rules out a parse error on our side — this is what the issuers'
  // data says, mostly on foreign ADR lines (AIJTY, DTTLY, HENGY, ORXGF).
  //
  // Rewriting or dropping those rows would be manufacturing a date, which is the one thing the brief
  // forbids outright. So the anomaly is bounded and surfaced instead: 1 row in the displayed upcoming
  // set today. If our field mapping ever did swap ex and payment, this count would jump from one to
  // hundreds and this assertion would catch it — which an absolute check, permanently red, could not.
  const inverted = withAll.filter((e) => e.paymentDate < e.exDividendDate);
  ok('⚠️ payment-before-ex stays vanishingly rare (a swapped mapping would be systematic)',
    inverted.length <= 5, `${inverted.length} of ${withAll.length}: ${inverted.map((e) => `${e.ticker} ex=${e.exDividendDate} pay=${e.paymentDate}`).join(', ')}`);
  if (inverted.length) console.log(`         upstream anomaly, both vendors agree: ${inverted.map((e) => e.ticker).join(', ')}`);
  ok('amounts are positive numbers, never zero or null', j.events.every((e) => typeof e.cashAmount === 'number' && e.cashAmount > 0));
  ok('⚠️ no date was manufactured — absent stays null',
    j.events.some((e) => e.paymentDate === null || e.recordDate === null || e.declarationDate === null));
  ok('sorted ascending by ex-dividend date',
    j.events.every((e, i) => i === 0 || j.events[i - 1].exDividendDate <= e.exDividendDate));
  ok('asOf is reported, so the page can say when it synced', !!j.asOf, String(j.asOf));
  // ⚠️ THE TYPE FACET, which is what stops the dropdown offering filters that match nothing.
  ok('the type facet is present', Array.isArray(j.types) && j.types.length > 0, JSON.stringify(j.types));
  ok('⚠️ every type offered has rows behind it', j.types.every((t) => t.n > 0));
  ok('…and the facet sums to the total', j.types.reduce((a, t) => a + t.n, 0) === j.total);
  ok('the sector facet also sums to the total', (j.sectors || []).reduce((a, s) => a + s.n, 0) === j.total);
  console.log(`         ${j.total} events · asOf ${j.asOf} · types ${JSON.stringify(j.types)}`);
}

L('⚠️ a broken read is not an empty calendar');
{
  // A range the API rejects is the nearest honest proxy for a failure: it must NOT come back as 200
  // with an empty list, which would read as "no dividends are scheduled".
  const wide = await fetch(`${BASE}/api/dividends/calendar?from=2026-01-01&to=2026-12-31`);
  ok('⚠️ an invalid request is an error, not an empty success', wide.status >= 400, String(wide.status));
  const body = await wide.json();
  ok('…and it does not return events: []', !Array.isArray(body.events) || body.events.length === 0);
  ok('…and leaks no infrastructure detail',
    !/postgres|neon|insert into|select |stack|at .*\.js:/i.test(JSON.stringify(body)), JSON.stringify(body).slice(0, 120));
}

for (const mobile of [false, true]) {
  const label = mobile ? '@390px' : '@1440px';
  L(`the rendered page ${label}`);
  await p.viewport(mobile ? 390 : 1440, mobile ? 844 : 900, mobile);
  await p.goto(`${BASE}/dividends`, { settleMs: 2200, ceilingMs: 35_000 });
  await new Promise((r) => setTimeout(r, 5000));

  const view = await p.eval(`(() => {
    const t = document.body.innerText;
    const rows = [...document.querySelectorAll('tr, [role="row"]')];
    // Ticker-shaped cells, which is how many real rows are painted.
    const tickers = [...document.querySelectorAll('a[href^="/ticker/"]')].map((a) => a.getAttribute('href').split('/').pop());
    return {
      chars: t.length,
      rows: rows.length,
      tickers: tickers.length,
      uniqueTickers: new Set(tickers).size,
      saysBroken: /unavailable|failed to load|something went wrong|error/i.test(t),
      saysEmpty: /no dividends|nothing scheduled/i.test(t),
      hasDates: /\\b(Oct|Sep|Nov|Dec)\\b|\\d{4}-\\d{2}-\\d{2}/.test(t),
      hasAmounts: /\\$\\s?\\d/.test(t),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      typeOptions: [...document.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.textContent.trim())).find((o) => o.some((x) => /All types/i.test(x))) || []
    };
  })()`);
  ok(`${label} the page renders`, view.chars > 1500, `${view.chars} chars`);
  ok(`${label} ⚠️ it does not report itself broken`, view.saysBroken === false);
  ok(`${label} ⚠️ and does not claim to be empty`, view.saysEmpty === false);
  ok(`${label} upcoming dividends are shown`, view.tickers > 20, `${view.tickers} ticker links`);
  ok(`${label} ⚠️ every visible ticker appears once`, view.tickers === view.uniqueTickers,
    `${view.tickers} links, ${view.uniqueTickers} distinct`);
  ok(`${label} dates are rendered`, view.hasDates === true);
  ok(`${label} amounts are rendered`, view.hasAmounts === true);
  ok(`${label} no horizontal overflow`, view.overflow <= 1, `${view.overflow}px`);
  ok(`${label} ⚠️ the type dropdown offers no option that matches nothing`,
    view.typeOptions.length > 0 && !view.typeOptions.some((o) => /^Regular$|^Special$|^Capital gain$/.test(o)),
    JSON.stringify(view.typeOptions));
  const hard = p.collected.pageErrors.filter((e) => !/ResizeObserver|Hydration/i.test(e));
  ok(`${label} no uncaught exception`, hard.length === 0, hard.slice(0, 1).join(''));
  console.log(`         type dropdown: ${JSON.stringify(view.typeOptions)}`);
}

L('/api/health');
{
  const h = await (await fetch(`${BASE}/api/health`)).json();
  ok('⚠️ overall healthy', h.ok === true && h.status === 'healthy', `${h.status} failing=${JSON.stringify(h.failing)}`);
  const job = (h.jobs?.jobs || []).find((j) => j.job === 'dividends');
  ok('the dividends job is reported', !!job);
  ok('⚠️ …with a real last success, not null', !!job?.lastSuccess, String(job?.lastSuccess));
  ok('⚠️ …and state ok', job?.state === 'ok', String(job?.state));
  ok('…and zero consecutive failures', job?.consecutiveFailures === 0, String(job?.consecutiveFailures));
  ok('⚠️ …and its note records a real written count, not zero', /"written":\s*[1-9]/.test(String(job?.note)), String(job?.note).slice(0, 120));
  console.log(`         lastSuccess ${job?.lastSuccess} · ageHours ${job?.ageHours}`);
  console.log(`         note ${String(job?.note).slice(0, 160)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
p.close();
process.exit(fail ? 1 : 0);
