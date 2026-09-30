const T = ['MU','AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','JPM','BAC','GS','WFC','KO','PEP',
  'NKE','COST','ORCL','ADBE','AVGO','CRM','FDX','LEN','KBH','DRI','GIS','CAG','ACN','TSM','SHOP',
  'WMT','TGT','HD','LOW','DE','CAT','XOM','CVX','PFE','JNJ','UNH','V','MA','DIS','NFLX','INTC','AMD'];
const out = [];
for (const t of T) {
  try {
    const j = await (await fetch(`https://www.catalystpit.com/api/earnings?ticker=${t}`)).json();
    out.push({ t, n: j.next, ann: j.meta?.announcements, count: j.count });
  } catch { out.push({ t, n: null, err: true }); }
}
const pad = (s, n) => String(s ?? '—').padEnd(n);
console.log(pad('TICKER',7)+pad('NEXT',13)+pad('BASIS',11)+pad('METHOD',13)+pad('SERIES',11)+pad('IMM',6)+'ANN');
for (const r of out) console.log(pad(r.t,7)+pad(r.n?.date,13)+pad(r.n?.basis,11)+pad(r.n?.method,13)+pad(r.n?.series,11)+pad(r.n?String(!!r.n.imminent):'—',6)+(r.ann??'—'));

const withNext = out.filter((r) => r.n?.date);
const byS = {}, byM = {};
for (const r of withNext) { byS[r.n.series] = (byS[r.n.series]||0)+1; byM[r.n.method] = (byM[r.n.method]||0)+1; }
console.log(`\n--- ${out.length} sampled ---`);
console.log(`produced a date        : ${withNext.length}/${out.length}`);
console.log(`null (cannot estimate) : ${out.length - withNext.length}  ${out.filter(r=>!r.n?.date).map(r=>r.t).join(' ')}`);
console.log(`series                : ${JSON.stringify(byS)}`);
console.log(`method                : ${JSON.stringify(byM)}`);
console.log(`imminent / overdue    : ${withNext.filter(r=>r.n.imminent).length}  ${withNext.filter(r=>r.n.imminent).map(r=>r.t).join(' ')}`);
console.log(`confirmed             : ${withNext.filter(r=>r.n.basis==='confirmed').length}`);
const past = withNext.filter(r=>r.n.date < '2026-09-30' && !r.n.imminent);
console.log(`⚠️ past date NOT flagged imminent (should be 0): ${past.length}  ${past.map(r=>r.t+':'+r.n.date).join(' ')}`);
const weekend = withNext.filter(r=>[0,6].includes(new Date(r.n.date+'T00:00:00Z').getUTCDay()));
console.log(`⚠️ landed on a weekend (should be 0): ${weekend.length}  ${weekend.map(r=>r.t+':'+r.n.date).join(' ')}`);
const far = withNext.filter(r=>r.n.date > '2027-01-15');
console.log(`⚠️ suspiciously far out >3.5mo (quarter-skip smell): ${far.length}  ${far.map(r=>r.t+':'+r.n.date).join(' ')}`);
