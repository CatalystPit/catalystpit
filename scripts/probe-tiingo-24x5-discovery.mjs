// IS THERE A SEPARATE "REAL-TIME CONSOLIDATED 24x5 EQUITY PRICES" PRODUCT, DISTINCT FROM /iex?
//
//   node --env-file=.env.local scripts/probe-tiingo-24x5-discovery.mjs
//
// The earlier probe exercised /iex and wss://api.tiingo.com/iex. Onboarding names a separate
// product, so this walks the plausible REST and WebSocket paths and records EXACTLY what each one
// answers. A 404 (no such route) and a 403 (route exists, not entitled) are different facts and
// both are worth more than a guess.
//
// Nothing here is inferred from documentation — only from responses.

const KEY = process.env.TIINGO_API_KEY;
if (!KEY) { console.error('TIINGO_API_KEY missing'); process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (s = '') => console.log(s);

async function probe(url, note = '') {
  await sleep(350);
  try {
    const r = await fetch(url, { headers: H });
    const body = (await r.text()).slice(0, 220).replace(/\s+/g, ' ');
    const mark = r.ok ? 'OK  ' : r.status === 404 ? '404 ' : r.status === 403 ? '403 ' : `${r.status} `;
    L(`  ${mark} ${url.replace(/\?.*$/, '')}${note ? '   (' + note + ')' : ''}`);
    L(`        ${body}`);
    return r.ok ? body : null;
  } catch (e) {
    L(`  ERR  ${url} — ${e.message}`);
    return null;
  }
}

L('=== REST CANDIDATES FOR A DISTINCT 24x5 EQUITY PRODUCT ===');
for (const [u, n] of [
  ['https://api.tiingo.com/tiingo/equities/AAPL/prices', 'equities namespace'],
  ['https://api.tiingo.com/tiingo/equities/AAPL', 'equities meta'],
  ['https://api.tiingo.com/tiingo/equities/meta', 'equities master'],
  ['https://api.tiingo.com/equities/AAPL', 'bare equities'],
  ['https://api.tiingo.com/tiingo/realtime/AAPL', 'realtime namespace'],
  ['https://api.tiingo.com/realtime/AAPL', 'bare realtime'],
  ['https://api.tiingo.com/tiingo/consolidated/AAPL', 'consolidated namespace'],
  ['https://api.tiingo.com/tiingo/daily/AAPL/prices?resampleFreq=1min', 'daily w/ intraday freq'],
  ['https://api.tiingo.com/iex/AAPL', 'KNOWN-GOOD control (IEX)'],
]) await probe(u, n);

L('\n=== WHAT DOES THE ACCOUNT ITSELF SAY IT HAS? ===');
for (const [u, n] of [
  ['https://api.tiingo.com/api/test', 'connectivity test'],
  ['https://api.tiingo.com/tiingo/utilities/search?query=AAPL', 'utilities'],
]) await probe(u, n);

L('\n=== WEBSOCKET CANDIDATES ===');
const wsProbe = (url, level) => new Promise((resolve) => {
  let settled = false;
  const finish = (verdict) => { if (settled) return; settled = true; L(`  ${verdict}`); try { ws.close(); } catch {} resolve(); };
  let ws;
  try { ws = new WebSocket(url); } catch (e) { return finish(`ERR  ${url} — ${e.message}`); }
  const t = setTimeout(() => finish(`TIMEOUT ${url} level=${level} — connected but silent`), 9000);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ eventName: 'subscribe', authorization: KEY, eventData: { thresholdLevel: level, tickers: ['aapl'] } }));
  });
  ws.addEventListener('message', (ev) => {
    clearTimeout(t);
    const s = String(ev.data).slice(0, 200).replace(/\s+/g, ' ');
    finish(`REPLY ${url} level=${level}\n        ${s}`);
  });
  ws.addEventListener('error', () => { clearTimeout(t); finish(`ERR  ${url} level=${level} — connection failed (route likely absent)`); });
  ws.addEventListener('close', () => { clearTimeout(t); finish(`CLOSED ${url} level=${level} — closed before any message`); });
});

for (const url of [
  'wss://api.tiingo.com/equities',
  'wss://api.tiingo.com/equity',
  'wss://api.tiingo.com/realtime',
  'wss://api.tiingo.com/consolidated',
]) { await wsProbe(url, 6); await sleep(300); }

L('\n=== THRESHOLD LEVEL SWEEP ON THE KNOWN IEX SOCKET ===');
for (const lvl of [0, 1, 2, 3, 4, 5, 6, 7]) { await wsProbe('wss://api.tiingo.com/iex', lvl); await sleep(250); }

L('\nDISCOVERY COMPLETE');
process.exit(0);
