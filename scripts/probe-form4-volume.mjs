const UA = { 'User-Agent': 'CatalystPit Research bcoghill88@gmail.com' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let tot = 0, days = 0;
const byYear = {};
for (const day of ['2026-09-10','2026-06-11','2026-03-12','2025-11-13','2025-05-14','2025-02-12','2024-09-12','2024-04-10','2023-10-11']) {
  const [y,m,d] = day.split('-');
  const q = 'QTR' + (Math.floor((Number(m)-1)/3)+1);
  await sleep(160);
  const r = await fetch(`https://www.sec.gov/Archives/edgar/daily-index/${y}/${q}/form.${y}${m}${d}.idx`, { headers: UA });
  if (!r.ok) { console.log(day, 'idx', r.status); continue; }
  const lines = (await r.text()).split('\n').filter(l => /^\s*4(\/A)?\s/.test(l));
  const acc = new Set(lines.map(l => l.match(/(\d{10}-\d{2}-\d{6})/)?.[1]).filter(Boolean));
  console.log(`${day}  index lines ${String(lines.length).padStart(5)}   DISTINCT filings ${String(acc.size).padStart(4)}   (dup factor ${(lines.length/acc.size).toFixed(1)}x)`);
  tot += acc.size; days++; (byYear[y] ||= []).push(acc.size);
}
const perDay = tot/days;
console.log('\nby year avg distinct filings/day:', Object.entries(byYear).map(([y,v])=>`${y}:${Math.round(v.reduce((a,b)=>a+b,0)/v.length)}`).join('  '));
console.log(`overall avg ${perDay.toFixed(0)} distinct Form 4 filings/trading day`);
const F3 = perDay*252*3, GAP = perDay*252*2.55;
console.log(`3 years  ~= ${(F3/1000).toFixed(0)}k filings  -> ${(F3/10/3600).toFixed(1)}h at 10 req/s`);
console.log(`the 2.55y we lack ~= ${(GAP/1000).toFixed(0)}k filings -> ${(GAP/10/3600).toFixed(1)}h`);
console.log(`rows: ~1.96 rows/filing overall, open-market (P+S) is 39.7% -> ~${(GAP*1.96*0.397/1000).toFixed(0)}k stored rows`);
console.log(`storage at ~693 B/row -> ~${(GAP*1.96*0.397*693/1e9).toFixed(2)} GB`);
