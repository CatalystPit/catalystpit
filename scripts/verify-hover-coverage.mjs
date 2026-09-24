// A CHART PREVIEW IS OFFERED ONLY WHERE THERE IS SOMETHING TO DRAW.
//
//   node --env-file=.env.local --experimental-loader ./scripts/ext-resolve-loader.mjs \
//        scripts/verify-hover-coverage.mjs [--mutate=m] [--live]
//
// ⚠️ THE BUG: hovering CYBN on Consensus opened the 1Y preview and it said "no data". CYBN is a
// real SEC filer with real insider evidence — it is on the board legitimately — but it was
// delisted from NYSE American on 2026-01-05 and now trades as HELP, so neither vendor has price
// data under that symbol and we hold zero candles for it.
//
// ⚠️ isRenderableTicker CANNOT CATCH THIS. That tests the SHAPE of a symbol, and CYBN, HYAC, CBKM,
// WINV and ZCAR are all perfectly well-formed. What decides it is whether we hold candles.
//
// Mutations:  --mutate=alwaysbind   hover is bound regardless of price history

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1] || '';
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const fs = await import('node:fs/promises');
const read = (p) => fs.readFile(new URL(p, import.meta.url), 'utf8');

L('=== ⚠️ THE GATE IS PRICE HISTORY, NOT SYMBOL SHAPE ===');
{
  const card = await read('../src/app/consensus/SetupCard.jsx');
  ok('⚠️ hover binds only when sessions > 0',
    mut('alwaysbind') ? false : /bindTicker && row\.market\?\.sessions > 0 \? bindTicker\(row\.ticker\)/.test(card),
    'binding a preview to a ticker with no candles opens a popup that can only say "no data"');
  ok('…the anchor still navigates either way', /href=\{`\/ticker\/\$\{encodeURIComponent\(row\.ticker\)\}`\}/.test(card));
  ok('⚠️ no ticker is named in the gate', !/CYBN|HYAC|CBKM|WINV|ZCAR/.test(card.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')),
    'a hardcoded exception would fix one symbol and leave the class');

  const mf = await read('../src/lib/consensus/market-facts.js');
  ok('the count comes from the bars already loaded', /sessions = bars\.length/.test(mf));
  // ⚠️ COUNTS CALLS, NOT THE DEFINITION. The naive match also found
  // "async function loadBars(ticker)" and reported two queries where there is one.
  ok('…so no extra query is added',
    (mf.match(/await loadBars\(ticker\)/g) || []).length === 1,
    String((mf.match(/await loadBars\(ticker\)/g) || []).length));
  ok('…and a load failure reports zero rather than a stale count', /sessions = 0;/.test(mf));
  ok('⚠️ no vendor call is introduced on hover', !/tiingo|polygon|api\./i.test(
    mf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
}

L('\n=== ⚠️ THE CHART PATH IS UNCHANGED ===');
{
  const hover = await read('../src/components/TickerHoverChart.jsx');
  ok('the preview still asks for 1Y on Consensus', /range: '1Y'/.test(hover));
  ok('…and other surfaces still default to 3M', /range = '3M'/.test(hover));
  ok('the chart component is untouched', /CompactChart/.test(hover));
  // ⚠️ STRIPPED FIRST. The file's header explains that a TradingView-hosted embed was REMOVED, and
  // matching the raw source reports that prose as the thing it forbids.
  const hoverCode = hover.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('⚠️ no hosted widget was introduced', !/tradingview\.com|s3\.tradingview/.test(hoverCode));
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE ===');
  const { marketFactsFor } = await import('../src/lib/consensus/market-facts.js');
  for (const t of ['CYBN', 'HYAC', 'CBKM', 'WINV', 'ZCAR']) {
    const mf = await marketFactsFor(t, {});
    ok(`⚠️ ${t}: no price history, so no preview is offered`, (mf.sessions || 0) === 0, `sessions=${mf.sessions}`);
  }
  for (const t of ['GME', 'GRAB', 'ADC', 'CDNL']) {
    const mf = await marketFactsFor(t, {});
    // ⚠️ THE CLAIM IS "IT CHARTS", NOT "IT HAS 200 SESSIONS". CDNL holds 197 and charts perfectly;
    // a threshold I picked would have failed a working ticker.
    ok(`${t}: still charts`, (mf.sessions || 0) > 0, `sessions=${mf.sessions}`);
  }
  // ⚠️ NO CROSS-TICKER CONTAMINATION: each count belongs to its own symbol.
  const { sql } = await import('drizzle-orm');
  const { db } = await import('../src/lib/db.js');
  for (const t of ['GME', 'ADC']) {
    const mf = await marketFactsFor(t, {});
    const r = (await db.execute(sql`select count(*)::int n from ticker_daily_candles
      where ticker = ${t} and date >= current_date - 400`)).rows[0];
    ok(`${t}: the count matches its OWN candles`, mf.sessions === Number(r.n), `${mf.sessions} vs ${r.n}`);
  }
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
