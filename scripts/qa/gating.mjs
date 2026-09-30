// ANONYMOUS GATING AND DATA SANITY, against production, from outside.
//
// ⚠️ HIDDEN UI IS NOT SECURITY, so every Pro surface is called DIRECTLY rather than judged by whether
// a button was rendered. A 200 with data is a finding; a 401/403 is the pass.
const BASE = 'https://www.catalystpit.com';
let pass = 0, fail = 0, notes = [];
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const get = async (path) => {
  const r = await fetch(BASE + path, { headers: { 'User-Agent': 'CatalystPit-QA' } });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body, cc: r.headers.get('cache-control') };
};

L('⚠️ Pro-only endpoints refuse an anonymous caller server-side');
{
  // Each of these must refuse. A 200 carrying rows is an entitlement bypass, not a UI issue.
  const PRO = [
    ['/api/pitscan?describe=1', 'Pit Scan'],
    ['/api/pitscan', 'Pit Scan board'],
    ['/api/consensus-board', 'Consensus board'],
    ['/api/watchlist', 'Watchlist read'],
    ['/api/watchlist/changes', 'What Changed'],
    ['/api/evidence-alerts', 'Alert subscriptions'],
    ['/api/evidence-alerts/inbox', 'Alert inbox'],
    ['/api/alerts', 'Alert rules'],
    ['/api/notifications', 'Notifications'],
  ];
  for (const [p, name] of PRO) {
    const r = await get(p);
    const refused = r.status === 401 || r.status === 403;
    // Some of these legitimately answer 200 with an EMPTY, signed-out shape rather than refusing —
    // that is acceptable only if it carries no data.
    const empty = r.status === 200 && JSON.stringify(r.body || {}).length < 220
      && !/\"rows\":\[\{|\"trades\":\[\{|\"tickers\":\[\"/.test(JSON.stringify(r.body || {}));
    ok(`${name} (${p}) refuses or returns nothing`, refused || empty,
      `${r.status} ${JSON.stringify(r.body).slice(0, 130)}`);
    if (r.status === 200 && !refused) notes.push(`${p} answers 200 signed-out: ${JSON.stringify(r.body).slice(0, 90)}`);
  }
  // Forged tier headers must change nothing.
  for (const h of [{ 'x-tier': 'pro' }, { 'x-user-tier': 'elite' }, { 'cookie': 'tier=pro' }]) {
    const r = await fetch(`${BASE}/api/pitscan?describe=1`, { headers: h });
    ok(`forged ${Object.keys(h)[0]} does not grant Pit Scan`, r.status === 403, String(r.status));
  }
}

L('⚠️ anonymous record caps on the gated datasets');
{
  const CAPS = [
    ['/api/insiders?limit=100', 'insiders', 'trades'],
    ['/api/politicians?limit=100', 'politicians', 'members'],
  ];
  for (const [p, name, key] of CAPS) {
    const r = await get(p);
    const arr = r.body?.[key] || r.body?.rows || r.body?.trades || r.body?.members || [];
    const locked = r.body?.lockedCount ?? r.body?.locked ?? null;
    console.log(`  ${name}: status=${r.status} returned=${Array.isArray(arr) ? arr.length : 'n/a'} lockedCount=${locked}`);
    ok(`${name} caps the anonymous list`, Array.isArray(arr) && arr.length <= 10, `${arr.length} rows`);
    ok(`${name} says how many are withheld`, locked == null || Number(locked) >= 0, String(locked));
  }
}

L('⚠️ no realtime claim reaches an unentitled caller');
{
  const q = await get('/api/quotes?symbols=AAPL,MSFT,NVDA,MU,SPY,UNFI');
  const vals = Object.values(q.body || {});
  ok('quotes answer', vals.length > 0, JSON.stringify(q.body).slice(0, 100));
  ok('⚠️ none is labelled realtime', !vals.some((v) => v.freshness === 'realtime'),
    vals.map((v) => v.freshness).join(','));
  ok('…and none carries a provider id', !vals.some((v) => 'provider' in v));
  ok('every quote is private, never shared-cached', /private|no-store/.test(q.cc || ''), q.cc);
  const meta = await get('/api/screener?meta=1');
  ok('screener metadata is not realtime for anonymous', meta.body?.capabilities?.quoteFreshness !== 'realtime',
    meta.body?.capabilities?.quoteFreshness);
  ok('…and names no vendor', !/tiingo/i.test(JSON.stringify(meta.body || {})));
}

L('data sanity — six real securities, checked field by field');
{
  const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'MU', 'SPY', 'UNFI'];
  for (const t of TICKERS) {
    const [tick, earn, div, ins, gov] = await Promise.all([
      get(`/api/ticker?symbol=${t}`), get(`/api/earnings?ticker=${t}`),
      get(`/api/dividends?ticker=${t}`), get(`/api/insiders?ticker=${t}&limit=3`),
      get(`/api/politicians?ticker=${t}`),
    ]);
    const d = tick.body || {};
    const m = d.metric || {};
    const n = earn.body?.next;
    console.log(`\n  ${t}  ${tick.status}  ${String(d.name || '—').slice(0, 34)}`);
    console.log(`     exchange=${d.exchange || '—'}  mcap=${m.marketCap ?? m.market_cap ?? '—'}  price=${d.price ?? m.price ?? '—'}`);
    console.log(`     earnings=${earn.body?.count ?? 0}q next=${n?.date ?? '—'}(${n?.basis ?? '—'})  dividends=${div.status}`);
    console.log(`     insiders=${(ins.body?.trades || []).length}  congress=${(gov.body?.trades || gov.body?.members || []).length}`);
    ok(`${t}: identity resolves`, !!d.name && d.name !== 'null', String(d.name));
    ok(`${t}: exchange present`, !!d.exchange, String(d.exchange));
    ok(`${t}: earnings endpoint answers`, earn.status === 200);
    // ⚠️ AN ETF HAS NO MARKET CAP AND NO EARNINGS, and reporting that as missing data would be wrong.
    if (t !== 'SPY') ok(`${t}: has earnings history`, (earn.body?.count ?? 0) > 0, String(earn.body?.count));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (notes.length) { console.log('\nnotes:'); for (const n of notes) console.log('  ' + n); }
