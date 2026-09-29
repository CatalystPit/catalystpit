// Does the Market Breadth card actually render the deployed numbers, in a browser?
// Run: node scripts/probe-breadth-live.mjs [baseUrl]
//
// ⚠️ THE CARD IS CLIENT-RENDERED. It fetches /api/market-breadth after mount, so the served HTML
// contains "Loading breadth…" and nothing else — fetching the page and string-matching the counts
// reports a failure that does not exist. This drives real Chrome and reads the painted DOM.
//
// ⚠️ DEVICE METRICS ARE SET BEFORE NAVIGATION. Applying them afterwards leaves the previous layout in
// place, so a 1440px viewport measures whatever column count the default window produced.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] || 'https://www.catalystpit.com';
const PORT = 9337;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
// Whitespace-insensitive: textContent concatenates adjacent spans without spaces, and JSX splits a
// sentence across lines, so neither side's spacing is meaningful.
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
const has = (hay, needle) => squash(hay).includes(squash(needle));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/cp-breadth-probe`, 'about:blank'], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 40; i++) {
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
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
await send('Page.enable'); await send('Runtime.enable');

// The API's own answer, so the DOM is checked against the deployed snapshot rather than a hardcoded one.
const api = (await (await fetch(`${BASE}/api/market-breadth`)).json()).breadth;
console.log(`\ndeployed snapshot: session ${api.asOfSession} vs ${api.priorSession}, universe ${api.universe}`);

const READ = `(() => {
  // ⚠️ ANCHORED ON THE HEADING ITSELF, then walked up exactly two levels to the card. Scanning every
  // div for "a child that starts with MARKET BREADTH" matches the first ANCESTOR containing the card,
  // whose header is the MARKETS card above it — the probe then reports the wrong element's text and
  // width and the failure is the probe's, not the page's.
  const hdr = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === 'MARKET BREADTH');
  const card = hdr ? hdr.parentElement.parentElement : null;
  if (!card) return { found: false, body: document.body.innerText.slice(0, 300) };
  // ⚠️ THE GRID IS SELECTED DIRECTLY. Walking up from a cell lands on a wrapper whose width is the
  // column's, not the grid's, which is how a 1440px measurement became 410px once before.
  const grid = card.querySelector('.cp-breadth-grid');
  const cells = grid ? [...grid.children] : [];
  return {
    found: true,
    header: card.firstElementChild ? card.firstElementChild.innerText : '',
    text: card.innerText,
    cardWidth: Math.round(card.getBoundingClientRect().width),
    gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : 0,
    cells: cells.length,
    columns: grid ? new Set(cells.map((c) => Math.round(c.getBoundingClientRect().left))).size : 0,
    titles: cells.map((c) => c.innerText.split('\\n').map((l) => l.trim()).filter(Boolean)),
    // ⚠️ AND THE GRID DIRECTLY ABOVE IT. The four breadth cards were asked for underneath the four
    // index charts, so the thing to check is that the two grids break into the same number of columns —
    // a 4-up row above a 2-up row reads as two unrelated components.
    marketCols: (() => {
      const m = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === 'MARKETS');
      const g = m ? m.parentElement.parentElement.querySelector('.cp-mkt-grid') : null;
      return g ? new Set([...g.children].map((c) => Math.round(c.getBoundingClientRect().left))).size : null;
    })(),
    // Why the grid is the width it is: the chain of ancestors that constrain it.
    chain: (() => { const out = []; let e = card; while (e && e !== document.body) { out.push(e.tagName.toLowerCase() + '.' + (e.className || '').toString().split(' ')[0] + ':' + Math.round(e.getBoundingClientRect().width)); e = e.parentElement; } return out; })(),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`;

for (const [label, width] of [['wide', 2560], ['desktop', 1440], ['phone', 390]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
  await send('Page.navigate', { url: BASE });
  let d = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { d = await ev(READ); } catch { d = null; }
    if (d?.found && d.cells === 4 && !/Loading breadth/.test(d.text)) break;
  }
  console.log(`\n=== ${label} (${width}px) ===`);
  if (!d?.found) { ok(`${label}: the breadth card is present`, false, d?.body || 'no card'); continue; }
  console.log(`  card ${d.cardWidth}px · grid ${d.gridWidth}px · ${d.cells} cells in ${d.columns} column(s)`);

  ok(`${label}: four cards render`, d.cells === 4, `${d.cells}`);
  console.log('  cell lines: ' + JSON.stringify(d.titles[0]));
  console.log('  chain: ' + d.chain.join(' < '));
  ok(`${label}: the four metrics are labelled`,
    ['ADVANCING', '52 WEEK', 'SMA 50', 'SMA 200'].every((t) => d.titles.some((lines) => lines.some((x) => x.includes(t)))),
    JSON.stringify(d.titles));
  ok(`${label}: it is not still loading`, !/Loading breadth|unavailable/.test(d.text));
  ok(`${label}: the header names the session it describes`, has(d.header, `CLOSE ${api.asOfSession}`), squash(d.header));
  ok(`${label}: no horizontal page scroll`, d.overflow <= 1, `${d.overflow}px`);
  // ⚠️ MEASURED AGAINST THE GRID ABOVE IT, NOT AGAINST THE VIEWPORT. At a 1440px viewport this card's
  // column is 412px, because the Terminal docks take ~660px out of the shell — so "four columns at
  // 1440px" is a false expectation about the page, and asserting it produced a failure that described
  // the probe rather than the product. The real requirement is the one that was asked for: these four
  // cards sit directly under the four index charts, so they break when those break.
  ok(`${label}: it breaks into the same columns as the index charts above it`,
    d.marketCols != null && d.columns === d.marketCols, `breadth ${d.columns} vs markets ${d.marketCols}`);
  ok(`${label}: no card is squeezed below 150px`,
    d.columns >= 1 && d.gridWidth / d.columns >= 150 - 1,
    `${d.columns} columns of ${Math.round(d.gridWidth / d.columns)}px in ${d.gridWidth}px`);

  // ⚠️ THE DEPLOYED COUNTS, NOT PLAUSIBLE ONES. Every figure below comes from the live API above.
  for (const [what, n] of [['advancing', api.advancing.up], ['declining', api.advancing.down],
    ['new highs', api.highsLows.up], ['new lows', api.highsLows.down],
    ['above SMA50', api.sma50.up], ['above SMA200', api.sma200.up]]) {
    ok(`${label}: ${what} shows ${n.toLocaleString('en-US')}`, has(d.text, n.toLocaleString('en-US')), squash(d.text).slice(0, 160));
  }
  // ⚠️ AND THE EXCLUSIONS, which are the whole point of the fix: the reader is told how much of the
  // universe this snapshot could not measure, and why.
  ok(`${label}: the universe is stated`, has(d.text, `${api.universe.toLocaleString('en-US')} U.S. common stocks`));
  ok(`${label}: both sessions are stated`, has(d.text, `${api.asOfSession} vs ${api.priorSession}`));
  ok(`${label}: non-trading securities are disclosed`,
    has(d.text, `${api.notTrading.toLocaleString('en-US')} did not trade that session`));
  ok(`${label}: securities with no prior close are disclosed`,
    has(d.text, `${api.noPriorClose.toLocaleString('en-US')} had no prior-session close`));
}

console.log(`\n${pass} passed, ${fail} failed`);
ws.close(); chrome.kill();
process.exit(fail ? 1 : 0);
