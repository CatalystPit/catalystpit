// Production verification for the insider audit fixes. Polls until the deployment lands, then checks
// the live API rather than the working tree.
//
//   node scripts/verify-insider-production.mjs
//
// The marker is behavioural, not a build id: /api/insiders?view=top sorts by value descending, so the
// retracted MYNZ row ($258,827,700,000) is either its #1 row or it is gone. Nothing else distinguishes
// the two deployments from outside.
const BASE = process.env.CP_BASE || 'https://catalystpit.com';
const get = async (p) => {
  const r = await fetch(BASE + p, { headers: { 'Cache-Control': 'no-cache' } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* keep text */ }
  return { status: r.status, json: j, text: t };
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const DEADLINE = Date.now() + 15 * 60_000;
let deployed = false;
while (Date.now() < DEADLINE) {
  const r = await get('/api/insiders?view=top');
  const rows = r.json?.trades || r.json?.rows || [];
  const superseded = rows.filter((x) => x.supersededBy);
  if (r.status === 200 && rows.length && superseded.length === 0) { deployed = true; break; }
  process.stdout.write('.');
  await new Promise((s) => setTimeout(s, 20_000));
}
console.log('');
if (!deployed) { console.error('FAIL — the deployment did not land, or superseded rows are still served'); process.exit(1); }

console.log('=== /api/insiders: no view serves a retracted filing ===');
for (const view of ['top', 'significant', 'buying', 'selling', 'transactions', 'all', 'ceo']) {
  const r = await get(`/api/insiders?view=${view}`);
  const rows = r.json?.trades || r.json?.rows || [];
  const bad = rows.filter((x) => x.supersededBy);
  ok(`view=${view} (${rows.length} rows) carries no supersededBy row`, r.status === 200 && bad.length === 0,
    bad.map((b) => `${b.ticker} $${b.totalValue}`).join(', '));
}

console.log('\n=== the specific retracted filing ===');
{
  const r = await get('/api/insiders?view=top');
  const rows = r.json?.trades || [];
  const mynz = rows.filter((x) => x.ticker === 'MYNZ');
  ok('⚠️ MYNZ\'s retracted $258.8B purchase is no longer the #1 insider transaction', mynz.length === 0,
    JSON.stringify(mynz.slice(0, 1)));
  ok('…and the top row is a real filing with a plausible price',
    rows[0] && Number(rows[0].pricePerShare) > 0 && Number(rows[0].pricePerShare) < 100_000,
    rows[0] ? `${rows[0].ticker} @ ${rows[0].pricePerShare}` : 'no rows');
  // The ticker drill-down feeds the /ticker insider tab as well.
  const t = await get('/api/insiders?ticker=MYNZ');
  const trades = t.json?.trades || [];
  ok('the MYNZ ticker drill-down excludes it too',
    trades.every((x) => !x.supersededBy), JSON.stringify(trades.filter((x) => x.supersededBy).slice(0, 2)));
  ok('⚠️ …while still showing the CORRECTION (the amendment is kept, not dropped)',
    trades.some((x) => x.isAmendment && Number(x.pricePerShare) > 0 && Number(x.pricePerShare) < 100),
    JSON.stringify(trades.map((x) => ({ amend: x.isAmendment, px: x.pricePerShare, sh: x.shares }))));
}

console.log('\n=== a signed-out caller still gets delayed/EOD market data ===');
{
  const q = await get('/api/quotes?symbols=AAPL');
  const first = Object.values(q.json || {})[0] || {};
  ok('quotes responds', q.status === 200);
  ok('⚠️ …and never claims real-time to an anonymous caller', first.freshness !== 'realtime',
    JSON.stringify(first).slice(0, 140));
  ok('…and declares its freshness', first.freshness === 'delayed' || first.freshness === 'eod', String(first.freshness));
}

console.log('\n=== cron health ===');
{
  const h = await get('/api/health');
  const jobs = h.json?.jobs?.jobs || [];
  for (const name of ['form4', 'insider-alerts']) {
    const j = jobs.find((x) => x.job === name);
    ok(`${name} cron is not failing`, !!j && j.state !== 'failing',
      j ? `state=${j.state} lastSuccess=${j.lastSuccess} fails=${j.consecutiveFailures}` : 'job not tracked');
  }
  ok('overall health is ok', h.json?.ok === true || h.json?.status === 'healthy', String(h.json?.status));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
