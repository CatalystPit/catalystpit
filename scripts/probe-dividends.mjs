// PROBE ONLY — dividend history source check. Run:
//   node --env-file=.env.local scripts/probe-dividends.mjs
// Tests Tiingo (EOD divCash) + Finnhub (/stock/dividend) for AAPL + STT. No edits beyond this script.

const TIINGO = process.env.TIINGO_API_KEY;
const FINNHUB = process.env.FINNHUB_KEY;
const TICKERS = ['AAPL', 'STT'];

const today = new Date();
const fmt = (d) => d.toISOString().slice(0, 10);
const from = (() => { const d = new Date(today); d.setFullYear(d.getFullYear() - 3); return fmt(d); })();
const to = fmt(today);

const inferFreq = (datesAsc) => {
  if (datesAsc.length < 2) return 'unknown (too few)';
  const gaps = [];
  for (let i = 1; i < datesAsc.length; i++) gaps.push((Date.parse(datesAsc[i]) - Date.parse(datesAsc[i - 1])) / 86400000);
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  if (med < 45) return `monthly (~${Math.round(med)}d median gap)`;
  if (med < 135) return `quarterly (~${Math.round(med)}d median gap)`;
  if (med < 270) return `semi-annual (~${Math.round(med)}d median gap)`;
  return `annual (~${Math.round(med)}d median gap)`;
};

async function tiingoDividends(ticker) {
  console.log(`\n  ── TIINGO  ${ticker}  (EOD /prices, divCash field) ──`);
  if (!TIINGO) { console.log('    TIINGO_API_KEY missing'); return; }
  const url = `https://api.tiingo.com/tiingo/daily/${ticker}/prices?startDate=${from}&endDate=${to}&format=json&token=${TIINGO}`;
  const r = await fetch(url);
  console.log(`    GET /tiingo/daily/${ticker}/prices?startDate=${from}&endDate=${to}  → HTTP ${r.status}`);
  if (!r.ok) { console.log('    body:', (await r.text()).slice(0, 300)); return; }
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) { console.log('    empty/non-array response'); return; }
  console.log(`    row count: ${rows.length} | per-row fields: ${Object.keys(rows[0]).join(', ')}`);
  const divs = rows.filter((d) => Number(d.divCash) > 0).sort((a, b) => a.date.localeCompare(b.date));
  console.log(`    rows with divCash>0: ${divs.length}`);
  if (divs.length) {
    console.log('    RAW shape of one dividend row:');
    console.log('   ', JSON.stringify(divs[divs.length - 1], null, 2).replace(/\n/g, '\n    '));
    console.log(`    inferred frequency: ${inferFreq(divs.map((d) => d.date.slice(0, 10)))}`);
    console.log(`    last ${Math.min(8, divs.length)} dividend events (ex-date | amount):`);
    for (const d of divs.slice(-8)) console.log(`      ${d.date.slice(0, 10)}  $${Number(d.divCash).toFixed(4)}`);
  } else {
    console.log('    >>> no divCash>0 in window — would need the paid fundamentals add-on for pay-date/declared');
  }
}

async function finnhubDividends(ticker) {
  console.log(`\n  ── FINNHUB  ${ticker}  (/stock/dividend) ──`);
  if (!FINNHUB) { console.log('    FINNHUB_KEY missing'); return; }
  const url = `https://finnhub.io/api/v1/stock/dividend?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB}`;
  const r = await fetch(url);
  const body = await r.text();
  console.log(`    GET /stock/dividend?symbol=${ticker}&from=${from}&to=${to}  → HTTP ${r.status}`);
  console.log('    raw body (≤400 chars):', body.slice(0, 400));
  if (r.status === 403 || /don.t have access|premium|paywall/i.test(body)) console.log('    >>> PAYWALLED on our tier');
}

async function main() {
  console.log(`window: ${from} → ${to}`);
  for (const t of TICKERS) {
    console.log('\n' + '='.repeat(78) + `\n${t}`);
    await tiingoDividends(t);
    await finnhubDividends(t);
  }
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
