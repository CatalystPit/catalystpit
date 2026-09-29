// PRODUCTION QA — drive the deployed site like a user and report what actually happens.
//
//   node scripts/qa-production.mjs [--browser chrome|edge] [--viewport 1440x900] [--theme light|dark]
//                                 [--base https://www.catalystpit.com] [--routes /,/screener] [--quiet]
//
// ⚠️ THE DEPLOYED PAGE, IN A REAL BROWSER. Nearly every surface here is client-rendered: fetching HTML
// and grepping it reports "empty" for pages that render fine and "fine" for pages whose data call 500s
// after mount. Everything below is read from the painted DOM, the console, and the network log.
//
// ⚠️ IT REPORTS, IT DOES NOT JUDGE. A finding here is a lead to confirm by hand, not a defect. Text
// heuristics in particular ("NaN", "Error") match legitimate copy, and a route that needs auth is
// supposed to bounce.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const BASE = arg('base', 'https://www.catalystpit.com');
const THEME = arg('theme', 'light');
const QUIET = flag('quiet');
const [VW, VH] = arg('viewport', '1440x900').split('x').map(Number);
const BROWSER = arg('browser', 'chrome');
const PORT = 9350 + (BROWSER === 'edge' ? 1 : 0) + (THEME === 'dark' ? 2 : 0) + (VW < 500 ? 4 : 0);
const BIN = (BROWSER === 'edge'
  ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  : ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
).find(existsSync);
if (!BIN) throw new Error(`no ${BROWSER} binary`);

const ROUTES = (arg('routes', '') || [
  '/', '/markets', '/screener', '/scan', '/terminal', '/charts', '/feed', '/news', '/watchlist',
  '/consensus', '/insiders', '/institutions', '/politicians', '/heatmap', '/fear-greed', '/crypto',
  '/dividends', '/leaderboard', '/account', '/settings/profile', '/sign-in', '/sign-up',
  '/ticker/AAPL', '/ticker/NVDA', '/ticker/BRK.B',
  // ⚠️ REAL SLUGS. Institution slugs come from the filer name and politician slugs are bioguide IDs, so
  // a guessed "nancy-pelosi" tests the not-found path, not the detail page. Both are worth testing —
  // labelled so a thin result is read as the right thing.
  '/institutions/blackrock-inc', '/institutions/family--vanguard', '/politicians/P000197',
  '/institutions/no-such-fund-exists', '/politicians/ZZZ9999', '/ticker/NOTATICKER',
  '/u/nobody-here-at-all', '/privacy', '/terms', '/disclaimer', '/contact',
  '/this-route-does-not-exist',
].join(',')).split(',').filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(BIN, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${process.env.TEMP}/cp-qa-${BROWSER}-${THEME}-${VW}`,
  'about:blank'], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = tabs.find((x) => x.type === 'page');
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch { /* wait */ }
    await sleep(250);
  }
  throw new Error('no debugging target');
}
const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method) events.push(m);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __evalError: r.exceptionDetails.exception?.description || 'eval failed' };
  return r.result.value;
};

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: VW < 500 });
// ⚠️ THEME IS SET BEFORE THE DOCUMENT'S OWN SCRIPTS RUN. Toggling it after load leaves a page that was
// painted light and then partly repainted, which is not a state any user sees.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: THEME === 'dark'
    ? "try{localStorage.setItem('cp_theme','dark');document.documentElement.setAttribute('data-theme','dark');}catch(e){}"
    : "try{localStorage.removeItem('cp_theme');}catch(e){}",
});

// ── what we look for in the painted text ─────────────────────────────────────
// ⚠️ DELIBERATELY NARROW. "Error" and "undefined" appear in legitimate copy; these are the strings a
// user should never see because they only come from a framework or a developer.
const LEAK = [
  ['next error overlay', /Unhandled Runtime Error|Application error: a client-side exception/i],
  ['server error page', /Internal Server Error|500: |502 Bad Gateway|504 Gateway/i],
  ['stack trace', /\bat [\w$.<>]+ \(https?:\/\/[^)]+:\d+:\d+\)/],
  ['raw exception', /TypeError:|ReferenceError:|SyntaxError:|Cannot read properties of/],
  ['dev placeholder', /\bTODO\b|\bFIXME\b|lorem ipsum|placeholder text|XXX_|DEBUG:/i],
  ['leaked local url', /localhost:\d+|127\.0\.0\.1:\d+/],
  ['unformatted number', /\bNaN\b|\bInfinity\b|\bundefinedundefined\b/],
  ['empty interpolation', /\$\{|\[object Object\]/],
];

const PROBE = `(() => {
  const t = document.body ? document.body.innerText : '';
  const de = document.documentElement;
  // A control that goes nowhere: an anchor with no usable href, or one still pointing at "#".
  const deadLinks = [...document.querySelectorAll('a')].filter((a) => {
    const h = a.getAttribute('href');
    return a.offsetParent !== null && (h === null || h === '' || h === '#');
  }).map((a) => (a.innerText || a.getAttribute('aria-label') || '(no label)').trim().slice(0, 40));
  const links = [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))
    .filter((h) => h && !h.startsWith('#') && !h.startsWith('mailto:') && !h.startsWith('tel:')))];
  // ⚠️ AN ELEMENT WIDER THAN THE VIEWPORT IS THE CAUSE, the page-level scrollbar is only the symptom.
  const wide = [...document.querySelectorAll('body *')].filter((e) => {
    const r = e.getBoundingClientRect();
    // ⚠️ THE RIGHT EDGE, NOT THE WIDTH. A 644px table inside an overflow-x:auto pane is wider than a
    // 390px viewport by design and scrolls nothing; what moves the page is an element whose right edge
    // lands past the viewport with nothing clipping it. Filtering on width reported the well-behaved
    // scroller and never showed the 19px that was actually there.
    return r.right > de.clientWidth + 1 && r.height > 4 && getComputedStyle(e).position !== 'fixed';
  }).slice(0, 6).map((e) => {
    const r = e.getBoundingClientRect();
    // ⚠️ WIDTH ALONE DOES NOT CAUSE A SCROLLBAR. A wide element inside an overflow-x:auto container is
    // a deliberate scroller; only one that no ancestor clips, and whose right edge passes the viewport,
    // moves the page. Reporting width by itself sent one QA pass chasing a table that was behaving.
    let clipped = false, a = e.parentElement;
    while (a && a !== de) { if (getComputedStyle(a).overflowX !== 'visible') { clipped = true; break; } a = a.parentElement; }
    // ⚠️ NO TEMPLATE LITERALS IN HERE, not even inside a comment. This whole probe is a template
    // literal on the Node side: a backtick closes it early and a dollar-brace interpolates in Node.
    const par = e.parentElement;
    return e.tagName.toLowerCase() + '.' + String(e.className || '').split(' ')[0]
      + ':w' + Math.round(r.width) + '@' + Math.round(r.left) + '..' + Math.round(r.right)
      + (clipped ? ' (clipped)' : ' ESCAPES'
        + ' parent=' + (par ? par.tagName.toLowerCase() + '.' + String(par.className || '').split(' ')[0]
          + ':w' + Math.round(par.getBoundingClientRect().width) : '?')
        + ' text="' + (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50) + '"');
  });
  return {
    title: document.title,
    theme: de.getAttribute('data-theme') || 'light',
    textLen: t.length,
    text: t.slice(0, 20000),
    h1: (document.querySelector('h1') || {}).innerText || null,
    overflow: de.scrollWidth - de.clientWidth,
    wide,
    deadLinks,
    links,
    // Still-spinning surfaces. Counted, because one "Loading…" in a lazy panel is normal and a page
    // made entirely of them is not.
    loadingCount: (t.match(/Loading|Loading…|Fetching|Please wait/gi) || []).length,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
  };
})()`;

// ⚠️ CONTRAST IS MEASURED, NOT EYEBALLED. "Unreadable in dark mode" is the single most common theme
// defect and it is invisible to every text assertion: the text is present, correct and the same colour
// as its background. WCAG contrast ratio, on the text nodes actually painted.
const CONTRAST = `(() => {
  const lum = (c) => {
    const m = c.match(/[\\d.]+/g); if (!m) return null;
    const [r, g, b] = m.slice(0, 3).map(Number);
    const a = m.length > 3 ? Number(m[3]) : 1;
    if (a < 0.25) return null; // effectively invisible by design (ghost text, spacers)
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    let e = el;
    while (e && e !== document.documentElement) {
      const c = getComputedStyle(e).backgroundColor;
      const m = c.match(/[\\d.]+/g);
      if (m && (m.length < 4 || Number(m[3]) > 0.5)) return c;
      e = e.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let n;
  while ((n = walk.nextNode())) {
    const s = n.nodeValue.trim();
    if (s.length < 2) continue;
    const el = n.parentElement;
    if (!el || el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const lf = lum(cs.color), lb = lum(bgOf(el));
    if (lf === null || lb === null) continue;
    const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
    const px = parseFloat(cs.fontSize) || 12;
    const bold = Number(cs.fontWeight) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      const key = cs.color + '|' + bgOf(el) + '|' + Math.round(px);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: s.slice(0, 44), ratio: Math.round(ratio * 100) / 100, need, px: Math.round(px),
        fg: cs.color, bg: bgOf(el), sel: el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0] });
    }
  }
  return out.sort((a, b) => a.ratio - b.ratio).slice(0, 8);
})()`;

const report = [];
for (const route of ROUTES) {
  events.length = 0;
  const url = BASE + route;
  let status = null, docFail = null;
  const t0 = Date.now();
  try { await send('Page.navigate', { url }); } catch (e) { docFail = e.message; }
  // Settle: wait for the load event, then for the network to go quiet, capped.
  await sleep(1200);
  let lastCount = -1;
  for (let i = 0; i < 24; i++) {
    const c = events.filter((e) => e.method === 'Network.requestWillBeSent').length;
    if (c === lastCount && i > 2) break;
    lastCount = c; await sleep(500);
  }
  const loadMs = Date.now() - t0;

  const reqs = events.filter((e) => e.method === 'Network.requestWillBeSent');
  const resps = events.filter((e) => e.method === 'Network.responseReceived');
  const fails = events.filter((e) => e.method === 'Network.loadingFailed');
  const doc = resps.find((e) => e.params.type === 'Document');
  status = doc?.params.response.status ?? null;

  const bad = resps.filter((e) => e.params.response.status >= 400)
    .map((e) => `${e.params.response.status} ${e.params.response.url.replace(BASE, '')}`);
  // ⚠️ THE URL LIVES ON request, NOT ON params. Reading params.url gave "?" for every failure, which
  // made a real third-party block indistinguishable from noise for a whole QA pass.
  const netFail = fails.filter((e) => !/net::ERR_ABORTED/.test(e.params.errorText || ''))
    .map((e) => {
      const r = reqs.find((q) => q.params.requestId === e.params.requestId);
      return `${e.params.errorText} ${(r?.params.request?.url || '(url unknown)').replace(BASE, '').slice(0, 110)}`;
    });

  // ⚠️ A LOOP IS THE SAME URL REPEATED, QUERY STRING INCLUDED. Collapsing on the path alone reports
  // "/api/logo x43" on the screener, which is 43 DIFFERENT logos — one per row, exactly as intended —
  // and buries any real loop in noise. The path-level count is kept separately as volume, not a defect.
  const counts = {}, paths = {};
  for (const r of reqs) {
    const u = r.params.request.url.replace(BASE, '');
    if (/\.(js|css|woff2?|png|svg|jpg|ico)$/.test(u.split('?')[0])) continue;
    counts[u] = (counts[u] || 0) + 1;
    paths[u.split('?')[0]] = (paths[u.split('?')[0]] || 0) + 1;
  }
  const repeated = Object.entries(counts).filter(([, n]) => n >= 4).map(([u, n]) => `${u.slice(0, 90)} x${n}`);
  const heavy = Object.entries(paths).filter(([, n]) => n >= 20).map(([u, n]) => `${u} x${n}`);

  const consoleErrs = events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map((e) => (e.params.args || []).map((a) => String(a.value ?? a.description ?? a.type)).join(' ').slice(0, 220));
  const thrown = events.filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text || '').slice(0, 220));
  const logErrs = events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    .map((e) => `${e.params.entry.text} ${e.params.entry.url || ''}`.slice(0, 220));

  const d = await ev(PROBE);
  const contrast = d && !d.__evalError ? await ev(CONTRAST) : [];
  const leaks = [];
  if (d && !d.__evalError) for (const [name, re] of LEAK) { const m = re.exec(d.text); if (m) leaks.push(`${name}: ${JSON.stringify(m[0].slice(0, 90))}`); }

  const row = {
    route, status, loadMs, ok: !docFail && status && status < 400,
    title: d?.title, theme: d?.theme, textLen: d?.textLen, h1: d?.h1,
    overflow: d?.overflow, wide: d?.wide || [], deadLinks: d?.deadLinks || [],
    links: d?.links || [], loadingCount: d?.loadingCount,
    bodyBg: d?.bodyBg, bodyColor: d?.bodyColor,
    bad, netFail, repeated, heavy, consoleErrs, thrown, logErrs, leaks, text: d?.text,
    contrast: Array.isArray(contrast) ? contrast : [],
    evalError: d?.__evalError || null,
  };
  report.push(row);

  const problems = [
    row.status >= 400 && route !== '/this-route-does-not-exist' ? `HTTP ${row.status}` : null,
    row.evalError ? `probe failed: ${row.evalError}` : null,
    row.textLen != null && row.textLen < 400 ? `almost no text (${row.textLen} chars)` : null,
    row.overflow > 2 ? `h-overflow ${row.overflow}px ${row.wide.join(',')}` : null,
    leaks.length ? `LEAK ${leaks.join(' | ')}` : null,
    thrown.length ? `THROWN ${thrown[0]}` : null,
    bad.length ? `HTTP-FAIL ${[...new Set(bad)].slice(0, 4).join(', ')}` : null,
    netFail.length ? `NET-FAIL ${[...new Set(netFail)].slice(0, 3).join(', ')}` : null,
    repeated.length ? `REPEATED ${repeated.slice(0, 3).join(", ")}` : null,
    heavy.length ? `HIGH-VOLUME ${heavy.join(", ")}` : null,
    consoleErrs.length ? `CONSOLE ${[...new Set(consoleErrs)].slice(0, 2).join(' | ')}` : null,
    row.deadLinks.length ? `DEAD-LINK ${[...new Set(row.deadLinks)].slice(0, 5).join(', ')}` : null,
    row.contrast.length ? `CONTRAST ${row.contrast.slice(0, 3).map((c) => `${c.ratio}:1 "${c.text}" ${c.px}px ${c.sel}`).join(' | ')}` : null,
    loadMs > 15000 ? `slow ${loadMs}ms` : null,
  ].filter(Boolean);

  const tag = problems.length ? 'ISSUE' : 'ok   ';
  console.log(`${tag} ${route}  [${status}] ${row.textLen}ch ${loadMs}ms${row.h1 ? ' h1="' + String(row.h1).slice(0, 34) + '"' : ''}`);
  if (!QUIET) for (const p of problems) console.log(`        ${p}`);
}

const out = `qa-${BROWSER}-${THEME}-${VW}.json`;
writeFileSync(`${process.env.TEMP}/${out}`, JSON.stringify(report, null, 1));
console.log(`\n${report.filter((r) => r.ok).length}/${report.length} routes loaded · detail: %TEMP%/${out}`);
ws.close(); chrome.kill();
