// Probe: Tiingo EOD daily candles. Run: node --env-file=.env.local scripts/probe-tiingo.mjs
const KEY = process.env.TIINGO_API_KEY;
if (!KEY) { console.error('TIINGO_API_KEY missing'); process.exit(1); }

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const end = new Date();
const start = new Date(end.getTime() - 90 * 864e5);

async function probe(ticker) {
  const url = `https://api.tiingo.com/tiingo/daily/${ticker}/prices?startDate=${ymd(start)}&endDate=${ymd(end)}`;
  const t0 = Date.now();
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` } });
  const ms = Date.now() - t0;
  console.log(`\n===== ${ticker} =====  HTTP ${r.status}  (${ms}ms)`);
  const body = await r.text();
  if (!r.ok) { console.log('ERROR body:', body.slice(0, 400)); return; }
  let data;
  try { data = JSON.parse(body); } catch { console.log('non-JSON:', body.slice(0, 400)); return; }
  if (!Array.isArray(data)) { console.log('non-array response:', JSON.stringify(data).slice(0, 400)); return; }
  console.log('rows:', data.length);
  if (data.length) {
    console.log('keys on row[0]:', Object.keys(data[0]).join(', '));
    console.log('first:', JSON.stringify(data[0]));
    console.log('last :', JSON.stringify(data[data.length - 1]));
  }
}

for (const t of ['AAPL', 'STT', 'FCNCA']) {
  try { await probe(t); } catch (e) { console.log(`${t} threw:`, e.message); }
}
