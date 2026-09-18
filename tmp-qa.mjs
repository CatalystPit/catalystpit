const { normalizeBars, barsUrl, initialBarsFor, timeframe } = await import('./src/lib/chart/chart-source.mjs');
const { computeIndicator } = await import('./src/lib/chart/chart-indicators.mjs');
const BASE='https://www.catalystpit.com';
const cache=new Map();
const get = async (u)=>{ if(!cache.has(u)) cache.set(u, await (await fetch(BASE+u)).json()); return cache.get(u); };
let pass=0, fail=0;
const ok=(n,c,d='')=>{ if(c)pass++; else{fail++;console.log(`   ✗ ${n}${d?' — '+d:''}`);} };

const SYMS = [['AAPL','1980 IPO, decades'],['KO','listed 1919, data from 2003'],['SPY','ETF, 1993'],['RDDT','2024 IPO'],['PLTR','2020 listing']];

for (const [sym,note] of SYMS) {
  console.log(`\n=== ${sym} (${note}) ===`);
  const daily = await get(barsUrl(sym,'1D'));       // range=5Y
  const all   = await get(barsUrl(sym,'1M'));       // range=all (shared by 1W/1M/3M/1Y)
  const raw = (all.candles||[]).filter(c=>c.date);
  console.log(`  raw daily candles (all): ${raw.length}  ${raw[0]?.date} → ${raw.at(-1)?.date}`);

  // 1D: at least 3 years when the provider has it
  const d = normalizeBars(daily,'1D').bars;
  const years = (new Date(d.at(-1).time) - new Date(d[0].time))/(365.25*864e5);
  const providerHas = (new Date(raw.at(-1).date) - new Date(raw[0].date))/(365.25*864e5);
  ok('1D ≥3y of daily candles (or all the provider has)', years >= 3 || Math.abs(years-providerHas) < 0.05, `${years.toFixed(2)}y of ${providerHas.toFixed(2)}y available`);
  ok('1D candles are daily', d.every(b=>/^\d{4}-\d{2}-\d{2}$/.test(b.time)));
  console.log(`  1D: ${d.length} candles, ${years.toFixed(2)}y`);

  for (const [tf,label] of [['1W','week'],['1M','month'],['3M','quarter'],['1Y','year']]) {
    const bars = normalizeBars(all,tf).bars;
    const times = bars.map(b=>b.time);
    ok(`${tf} ascending`, times.every((t,i)=>i===0||times[i-1]<t));
    ok(`${tf} unique`, new Set(times).size===times.length);
    ok(`${tf} OHLC sane`, bars.every(b=>b.high>=b.low && b.high>=Math.max(b.open,b.close) && b.low<=Math.min(b.open,b.close)));
    // full history: first aggregated candle must cover the first raw daily candle
    ok(`${tf} reaches the first available session`, times[0] <= raw[0].date, `${times[0]} vs raw ${raw[0].date}`);

    // INDEPENDENT recomputation of the LAST COMPLETE bucket straight from raw dailies
    const key = (ds)=>{ const [y,m,dd]=ds.split('-').map(Number);
      if(label==='year') return `${y}`;
      if(label==='quarter') return `${y}-Q${Math.floor((m-1)/3)+1}`;
      if(label==='month') return `${y}-${String(m).padStart(2,'0')}`;
      const z=Date.UTC(y,m-1,dd)/864e5; const mon=z-(((z+3)%7)+7)%7; return 'W'+mon; };
    const groups=new Map();
    for(const c of raw){ const k=key(c.date); if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(c); }
    const ks=[...groups.keys()];
    const target=ks[ks.length-2];                     // last COMPLETE bucket
    const g=groups.get(target);
    const expect={open:g[0].open, close:g.at(-1).close, high:Math.max(...g.map(x=>x.high)), low:Math.min(...g.map(x=>x.low)), vol:g.reduce((s,x)=>s+(Number(x.volume)||0),0)};
    const got=bars[bars.length-2];
    ok(`${tf} OPEN = first day's open`, got.open===expect.open, `${got.open} vs ${expect.open}`);
    ok(`${tf} CLOSE = last day's close`, got.close===expect.close, `${got.close} vs ${expect.close}`);
    ok(`${tf} HIGH = max`, got.high===expect.high, `${got.high} vs ${expect.high}`);
    ok(`${tf} LOW = min`, got.low===expect.low, `${got.low} vs ${expect.low}`);
    ok(`${tf} VOLUME = sum of ${g.length} sessions`, Math.abs((got.volume||0)-expect.vol) < 1, `${got.volume} vs ${expect.vol}`);
    console.log(`  ${tf}: ${bars.length} candles, ${times[0]} → ${times.at(-1)}, shows ${initialBarsFor(tf)??'all'}`);
  }

  // Indicators read the DISPLAYED interval
  const monthly = normalizeBars(all,'1M').bars;
  if (monthly.length > 25) {
    const sma = computeIndicator('sma', monthly, {length:20}, {intraday:false,sessionKey:null}).plots[0].data;
    ok('SMA20 on 1M emits (monthlyCandles-19) points', sma.length === monthly.length-19, `${sma.length} vs ${monthly.length-19}`);
    ok('SMA20 on 1M is stamped on monthly timestamps', monthly.some(b=>b.time===sma[0].time));
    const man = monthly.slice(-20).reduce((s,b)=>s+b.close,0)/20;
    ok('SMA20 last value = mean of last 20 MONTHLY closes', Math.abs(sma.at(-1).value-man)<1e-6, `${sma.at(-1).value} vs ${man}`);
    ok('it did NOT compute on daily bars', sma.length !== raw.length-19);
  }
}
console.log(`\n${pass} checks passed, ${fail} failed`);
