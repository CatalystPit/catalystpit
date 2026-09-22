// WHAT THE REAL-TIME FEED ACTUALLY PUSHES — one short connection, then disconnect.
//
//   node --env-file=.env.local scripts/probe-tiingo-websocket.mjs [thresholdLevel] [seconds]
//
// The REST /iex quote returns tngoLast but leaves last/bid/ask null, so the question this answers
// is whether the streaming feed carries top-of-book and trade prints that REST does not — and what
// any volume field on it actually represents.
//
// ⚠️ DELIBERATELY BRIEF AND SINGLE-CONNECTION. This is discovery, not a subscription. It connects
// once, listens for a fixed number of seconds, prints the shape of what arrived, and closes. It
// must never be left running and must never be the model for production fan-out.

const KEY = process.env.TIINGO_API_KEY;
if (!KEY) { console.error('TIINGO_API_KEY missing'); process.exit(1); }

const LEVEL = Number(process.argv[2] ?? 5);
const SECONDS = Math.min(Number(process.argv[3] ?? 20), 45);
const TICKERS = ['aapl', 'nvda', 'spy', 'amd'];
const L = (s = '') => console.log(s);

L(`connecting  thresholdLevel=${LEVEL}  listening ${SECONDS}s  tickers=${TICKERS.join(',')}`);

const ws = new WebSocket('wss://api.tiingo.com/iex');
let msgs = 0, data = 0;
const seenTypes = new Map();
const samples = [];
let subscriptionReply = null;

const done = (why) => {
  L(`\n── closed: ${why}`);
  L(`   messages=${msgs}  data messages=${data}`);
  L(`   message types seen: ${[...seenTypes.entries()].map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`);
  if (subscriptionReply) L(`   subscription reply: ${JSON.stringify(subscriptionReply).slice(0, 300)}`);
  if (samples.length) {
    L('\n   SAMPLE PAYLOADS (raw):');
    for (const s of samples.slice(0, 6)) L(`     ${s}`);
  } else {
    L('\n   no data rows arrived — either the level is not entitled, or the market is quiet');
  }
  try { ws.close(); } catch {}
  process.exit(0);
};

ws.addEventListener('open', () => {
  L('   socket open, subscribing…');
  ws.send(JSON.stringify({
    eventName: 'subscribe',
    authorization: KEY,
    eventData: { thresholdLevel: LEVEL, tickers: TICKERS },
  }));
});

ws.addEventListener('message', (ev) => {
  msgs += 1;
  let j = null;
  try { j = JSON.parse(ev.data); } catch { return; }
  const t = j?.messageType || 'unknown';
  seenTypes.set(t, (seenTypes.get(t) || 0) + 1);
  if (t === 'I' || j?.response) subscriptionReply = j;
  if (t === 'A') {                      // 'A' = data row
    data += 1;
    if (samples.length < 8) samples.push(JSON.stringify(j.data ?? j));
  } else if (t === 'E') {
    L(`   ERROR message: ${JSON.stringify(j).slice(0, 300)}`);
  }
});

ws.addEventListener('error', (e) => L(`   socket error: ${e?.message || 'unknown'}`));
ws.addEventListener('close', () => done('server closed'));
setTimeout(() => done('listen window elapsed'), SECONDS * 1000);
