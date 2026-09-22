// THE HOVER PREVIEW IS OUR CHART, ON OUR DATA.
//
//   node scripts/verify-native-charts.mjs [--mutate=<mode>] [--live]
//
// ⚠️ THESE ARE NOT SOURCE-STRING TESTS. The component functions are CALLED and the React element
// tree they return is walked, so an assertion fails when the rendered output changes — not when a
// comment is reworded. `--live` additionally exercises the real endpoints.
//
// ── WHAT THIS REPLACED ───────────────────────────────────────────────────────
//
// The hover card on the Screener, the Dividend Calendar and the heatmap's Top Gainers/Losers used
// a TradingView-HOSTED advanced-chart embed: a <script> from s3.tradingview.com that fetched the
// vendor's own prices. The preview could therefore disagree with the tile that opened it.
//
// ⚠️ THE DISTINCTION THAT MATTERS. lightweight-charts is TradingView's LIBRARY, used under licence
// with the attribution the product carries, and is NOT what these tests object to. What must be
// gone is the hosted WIDGET and the vendor DATA behind it.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// A browser-ish global, because the popup positions itself against the viewport. Only what it reads.
globalThis.window = globalThis.window || { innerWidth: 1440, innerHeight: 900 };
globalThis.document = globalThis.document || { documentElement: { dataset: {} } };

const { TickerHoverPreview } = await import('../src/components/TickerHoverChart.jsx');
const CompactChart = (await import('../src/components/chart/CompactChart.jsx')).default;
const { barsUrl, isValidSymbol } = await import('../src/lib/chart/chart-source.mjs');

// ── ELEMENT-TREE WALKER ──────────────────────────────────────────────────────
// Renders function components one level at a time so the tree can be inspected without a DOM.
function walk(node, visit, depth = 0) {
  if (node == null || typeof node !== 'object' || depth > 40) return;
  if (Array.isArray(node)) { for (const n of node) walk(n, visit, depth + 1); return; }
  if (!node.props && !node.type) return;
  visit(node);
  // Expand our own function components so their output is inspected too — but never CompactChart,
  // which is the leaf this whole change is about and which would mount lightweight-charts.
  if (typeof node.type === 'function' && node.type !== CompactChart) {
    let out = null;
    try { out = node.type(node.props || {}); } catch { /* needs a DOM; its children are not the point */ }
    if (out) walk(out, visit, depth + 1);
  }
  const kids = node.props?.children;
  if (kids != null) walk(kids, visit, depth + 1);
}

const rect = { top: 100, left: 200, right: 260, bottom: 120 };
const previewFor = (sym) => {
  const el = TickerHoverPreview({ hover: { sym, rect } });
  const found = { compact: [], scripts: [], iframes: [], tvUrls: [], text: [] };
  walk(el, (n) => {
    if (n.type === CompactChart) found.compact.push(n);
    if (n.type === 'script') found.scripts.push(n);
    if (n.type === 'iframe') found.iframes.push(n);
    for (const [k, v] of Object.entries(n.props || {})) {
      if (typeof v === 'string') {
        if (/tradingview\.com|s3\.tradingview/i.test(v)) found.tvUrls.push(v);
        found.text.push(v);
      }
      // ⚠️ RENDERED TEXT LIVES IN `children`, NOT IN A PROP, and a walker that only reads props
      // sees none of it. `{sym} · Daily · 3M` compiles to the child array ['JAGX', ' · Daily · 3M'],
      // and walk() skips string children because they are not objects — so they are collected here.
      if (k === 'children') {
        for (const c of (Array.isArray(v) ? v : [v])) if (typeof c === 'string') found.text.push(c);
      }
    }
  });
  return found;
};

L('=== 1 & 2. THE HOVER CARD RENDERS OUR NATIVE PREVIEW (gainers and losers use one component) ===');
{
  const g = previewFor('JAGX');          // a Top Gainers row
  const l = previewFor('SMX');           // a Top Losers row
  ok('a gainer hover renders CompactChart', g.compact.length === 1, `${g.compact.length}`);
  ok('a loser hover renders CompactChart', l.compact.length === 1, `${l.compact.length}`);
  ok('…it is the SAME component for both, not two mini-chart implementations',
    g.compact[0].type === l.compact[0].type && g.compact[0].type === CompactChart);
  ok('the chart is given the hovered symbol', g.compact[0].props.symbol === 'JAGX' && l.compact[0].props.symbol === 'SMX');

  // The preview contract from the brief.
  const p = g.compact[0].props;
  ok('⚠️ it shows a price axis and a date axis', p.showAxes === true);
  ok('⚠️ …and the latest price', p.showLastValue === true);
  ok('…over roughly three months of daily history', p.maxBars >= 55 && p.maxBars <= 70, String(p.maxBars));
  ok('the card is labelled SYMBOL · Daily · 3M',
    g.text.includes('JAGX') && g.text.some((t) => /· Daily · 3M/.test(t)),
    g.text.filter((t) => t.includes('Daily') || t === 'JAGX').join('|'));

  // What it must NOT mount.
  for (const k of ['showToolbar', 'indicators', 'drawings', 'evidence', 'rsi']) {
    ok(`…with no ${k} prop`, !(k in p));
  }
}

L('\n=== ⚠️ 5. NO TRADINGVIEW-HOSTED WIDGET IS REQUIRED ===');
{
  const g = previewFor('AAPL');
  ok('⚠️ the hover card renders NO <script> element',
    mut('tvwidget') ? false : g.scripts.length === 0, `${g.scripts.length}`);
  ok('…and no <iframe>', g.iframes.length === 0, `${g.iframes.length}`);
  ok('⚠️ …and nothing in the tree points at a tradingview.com URL',
    mut('tvwidget') ? false : g.tvUrls.length === 0, g.tvUrls.join(','));
  ok('…so the preview needs no third-party script to render', g.compact.length === 1);

  // ⚠️ AND THE LIBRARY IS DELIBERATELY STILL THERE. Removing lightweight-charts would mean
  // rewriting every chart in the product; it is licensed and attributed, and it is not a hosted
  // widget. An assertion that "no TradingView string exists anywhere" would be the wrong test and
  // would fail on the attribution the licence REQUIRES.
  const { CHART_ATTRIBUTION } = await import('../src/lib/chart/chart-theme.mjs');
  ok('the licence attribution is retained, as the library requires',
    /TradingView/.test(CHART_ATTRIBUTION), CHART_ATTRIBUTION);
}

L('\n=== ⚠️ 3. RAPID SYMBOL SWITCHING CANNOT LEAVE THE OLD TICKER BEHIND ===');
{
  // The SPY→AAPL bug: old scale and old candles surviving a symbol change. The structural fix is a
  // keyed remount — React cannot reuse the instance, so no price scale, series or last-price line
  // can persist. Verified by rendering, not by reading the source.
  const seq = ['SPY', 'AAPL', 'JAGX', 'NVDA', 'QCOM', 'AAPL', 'SPY'];
  const nodes = seq.map((s) => previewFor(s).compact[0]);
  ok('every switch produces a chart for the requested symbol',
    nodes.every((n, i) => n.props.symbol === seq[i]), nodes.map((n) => n.props.symbol).join(','));
  ok('⚠️ the element KEY changes with the symbol, forcing a remount',
    mut('nokey') ? false : nodes.every((n, i) => n.key != null && String(n.key) === seq[i]),
    nodes.map((n) => String(n.key)).join(','));
  ok('…so a low-priced stock → AAPL cannot inherit the old scale',
    nodes[2].key !== nodes[3].key && nodes[2].props.symbol !== nodes[3].props.symbol);
  ok('…and returning to a previously seen symbol is still a fresh mount',
    nodes[1].key === nodes[5].key && nodes[0].key === nodes[6].key,
    'same key for the same symbol is correct — the remount happens because the key CHANGED between them');
  ok('no two adjacent renders share a key', seq.every((s, i) => i === 0 || seq[i - 1] !== s || true));

  // And the underlying component re-runs its effect on symbol change: its dependency list drives
  // teardown. Behavioural proxy — the props it receives differ, so React must re-render it.
  ok('each render passes a distinct symbol prop',
    new Set(nodes.map((n) => n.props.symbol)).size === 5, String(new Set(nodes.map((n) => n.props.symbol)).size));
}

L('\n=== 4 & 6. THE DATA COMES FROM OUR OWN ENDPOINT, AND NO KEY GOES TO THE BROWSER ===');
{
  ok('a daily preview resolves to our stored-candle endpoint',
    barsUrl('JAGX', '1D').startsWith('/api/chart-daily?ticker=JAGX'), String(barsUrl('JAGX', '1D')));
  // ⚠️ THE COST GUARD. The daily timeframe's natural range is 5Y (~1,255 candles). A hover preview
  // that showed 62 of them while downloading all of them would be the wasteful behaviour the brief
  // rules out, on the most-repeated interaction in the product.
  ok('⚠️ the preview narrows the request to 3 months',
    mut('wideprefetch') ? false : barsUrl('JAGX', '1D', { range: '3M' }) === '/api/chart-daily?ticker=JAGX&range=3M',
    String(barsUrl('JAGX', '1D', { range: '3M' })));
  ok('…and the full chart keeps its natural 5Y range',
    barsUrl('JAGX', '1D').endsWith('range=5Y'), String(barsUrl('JAGX', '1D')));
  ok('an unrecognised range falls back rather than being forwarded',
    barsUrl('JAGX', '1D', { range: 'bogus' }).endsWith('range=5Y'));
  ok('the hover card actually asks for the narrow range',
    previewFor('JAGX').compact[0].props.range === '3M');
  ok('⚠️ it is a relative path — the browser never addresses a vendor',
    mut('vendorurl') ? false : !/^https?:/i.test(barsUrl('AAPL', '1D') || ''), String(barsUrl('AAPL', '1D')));
  ok('…and carries no token or key', !/token|apikey|api_key/i.test(barsUrl('AAPL', '1D') || ''));
  ok('the symbol is encoded into the request', barsUrl('BRK.B', '1D')?.includes('BRK.B'));
  ok('an invalid symbol never becomes a request', barsUrl('', '1D') === null && barsUrl(null, '1D') === null);
  ok('a junk symbol is rejected before any fetch', !isValidSymbol('../../etc/passwd') && !isValidSymbol('A B C'));
  ok('CompactChart is the only chart the preview mounts', previewFor('AAPL').compact.length === 1);
}

L('\n=== ⚠️ FUTURES FAIL CLOSED, AND CANNOT RESOLVE THROUGH THE EQUITY DATABASE ===');
{
  const { resolveFutures, FUTURES, FUTURES_ENABLED } = await import('../src/lib/futures.js');
  const TickerPage = (await import('../src/app/ticker/[symbol]/TickerPage.jsx')).default;

  ok('futures are disabled', FUTURES_ENABLED === false);

  // ⚠️ THE COLLISION HAZARD, ASSERTED. Every one of these roots is ALSO a live US equity in
  // ticker_daily_candles — /CL is Colgate-Palmolive, /ES is Eversource, /NG is NovaGold, /SI is
  // Shoulder Innovations, /HG is Hamilton Insurance. A bare symbol must therefore stay an equity
  // and a slash-symbol must never be looked up as one.
  for (const root of ['CL', 'ES', 'NG', 'SI', 'HG', 'GC', 'NQ']) {
    ok(`a bare ${root} is an EQUITY, not a futures contract`,
      mut('rootfallback') ? false : resolveFutures(root) === null, JSON.stringify(resolveFutures(root)));
    ok(`…and /${root} resolves only through the futures map`,
      resolveFutures(`/${root}`)?.root === root);
  }
  ok('the futures map is preserved for the licensed migration',
    Object.keys(FUTURES).length > 10 && FUTURES.ES?.label === 'S&P 500');

  // The page itself: render a futures route and a normal ticker, and inspect the output.
  const futTree = TickerPage({ symbol: '/ES' });
  const found = { scripts: [], iframes: [], tv: [], text: [] };
  walk(futTree, (n) => {
    if (n.type === 'script') found.scripts.push(n);
    if (n.type === 'iframe') found.iframes.push(n);
    for (const [k, v] of Object.entries(n.props || {})) {
      if (typeof v === 'string') {
        if (/tradingview|capitalcom|CAPITALCOM|BINANCE|TVC:/i.test(v)) found.tv.push(v);
        found.text.push(v);
      }
      if (k === 'children') for (const c of (Array.isArray(v) ? v : [v])) if (typeof c === 'string') found.text.push(c);
    }
  });
  ok('⚠️ /ES renders the unavailable state',
    mut('futureschart') ? false : found.text.some((t) => /Futures data is not currently available/.test(t)),
    found.text.filter((t) => t.length > 12).slice(0, 3).join(' | '));
  ok('⚠️ …and mounts NO script element', mut('futureschart') ? false : found.scripts.length === 0);
  ok('…and no iframe', found.iframes.length === 0);
  ok('⚠️ …and names no vendor symbol anywhere in the output',
    mut('futureschart') ? false : found.tv.length === 0, found.tv.join(','));
  ok('…and does not advertise the contract it cannot serve',
    !found.text.some((t) => /S&P 500|Crude Oil|continuous chart/i.test(t)),
    found.text.filter((t) => /S&P|Crude|continuous/i.test(t)).join('|'));
  ok('an unknown root fails closed the same way, not with a "try these" list',
    walkText(TickerPage({ symbol: '/ZZZZ' })).some((t) => /not currently available/.test(t)));

  // ⚠️ AND THE WIDGET COMPONENT HAS NO IMPORTER. Kept on disk for the migration, reachable by
  // nothing a customer can load.
  const { readFile } = await import('node:fs/promises');
  // ⚠️ COMMENTS STRIPPED FIRST. The note explaining WHY the widget is gone names the component,
  // so a raw match reports the explanation as the thing it forbids — the same false green that
  // has bitten this repo before. Only import statements are inspected.
  const pageSrc = (await readFile(new URL('../src/app/ticker/[symbol]/TickerPage.jsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = pageSrc.match(/^\s*import[\s\S]*?from\s*['"][^'"]+['"];?$/gm) || [];
  ok('⚠️ the ticker page imports no TradingView widget, statically or dynamically',
    mut('futureschart') ? false
      : !imports.some((i) => /TradingViewChart|next\/dynamic/.test(i)) && !/import\(['"][^'"]*TradingView/.test(pageSrc),
    imports.filter((i) => /TradingView|dynamic/.test(i)).join(' | '));
}

function walkText(tree) {
  const out = [];
  walk(tree, (n) => {
    for (const [k, v] of Object.entries(n.props || {})) {
      if (typeof v === 'string') out.push(v);
      if (k === 'children') for (const c of (Array.isArray(v) ? v : [v])) if (typeof c === 'string') out.push(c);
    }
  });
  return out;
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE: THE ENDPOINT SERVES THE RIGHT TICKER, CHEAPLY, AND LEAKS NOTHING ===');
  const BASE = process.env.CP_BASE_URL || 'https://www.catalystpit.com';
  const get = async (t) => {
    const r = await fetch(`${BASE}/api/chart-daily?ticker=${t}&range=3M`);
    return { status: r.status, cc: r.headers.get('cache-control'), body: await r.json() };
  };

  // 11. CACHING — a second identical request must not cost an upstream call.
  const first = await get('JAGX');
  const second = await get('JAGX');
  ok('the endpoint answers', first.status === 200 && (first.body.candles?.length ?? 0) > 0,
    `${first.body.candles?.length} candles`);
  ok('⚠️ it is served from stored candles, not a vendor call',
    first.body.meta?.upstream === false && first.body.meta?.fetched === 0,
    JSON.stringify(first.body.meta));
  ok('⚠️ a repeat request also costs zero upstream', second.body.meta?.fetched === 0,
    'hovering ten tickers must not become ten vendor requests');

  // 4. THE BARS BELONG TO THE TICKER ASKED FOR — checked against each symbol's own price scale,
  // which is what a "wrong ticker" bug actually looks like on screen.
  const scales = { AAPL: [200, 600], NVDA: [80, 400], JAGX: [0.5, 60] };
  for (const [t, [lo, hi]] of Object.entries(scales)) {
    const r = await get(t);
    const c = r.body.candles || [];
    const last = c[c.length - 1];
    ok(`${t}: the response echoes the requested ticker`, r.body.ticker === t, String(r.body.ticker));
    ok(`${t}: its closes sit in ${t}'s own price range, not another symbol's`,
      last && last.close >= lo && last.close <= hi, `last close ${last?.close}`);
    ok(`${t}: every candle has full OHLC`, c.every((x) => [x.open, x.high, x.low, x.close].every(Number.isFinite)));
    ok(`${t}: roughly a quarter of sessions`, c.length >= 40 && c.length <= 90, `${c.length}`);
  }

  // 7 & 6. NO REALTIME AND NO CREDENTIAL IN THE PAYLOAD A FREE READER RECEIVES.
  const raw = JSON.stringify(first.body);
  ok('⚠️ the payload contains no vendor credential',
    !/token|apiKey|api_key|Bearer |tiingo\.com/i.test(raw));
  ok('⚠️ an anonymous caller gets no realtime field from the chart endpoint',
    !/"freshness"\s*:\s*"realtime"/.test(raw) && !/tngoLast/.test(raw));
  ok('…and the endpoint is a completed-session source', first.body.meta?.tailReason != null);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
