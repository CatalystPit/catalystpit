// ACCOUNT ISOLATION FOR THE CHART WORKSPACE.
//
// ── ⚠️ THE BUG THIS LOCKS DOWN ──────────────────────────────────────────────
//
// Every chart storage key was global to the browser. Sign out of one account, sign into another on
// the same machine, open NVDA, and the second account was handed the first account's trend lines
// and indicators — one customer's workspace shown to another. Two faults compounded: the KEY
// belonged to the device rather than the account, and the chart LOADED ONCE ON MOUNT, so even a
// scoped key would have kept serving stale state through React while the component stayed mounted.
//
// Everything below runs against a real fake localStorage, exercising the actual store modules.
//
// Run: node scripts/verify-chart-account-isolation.mjs

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

// ── a localStorage good enough for the stores, and inspectable ──────────────
class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  get keys() { return [...this.map.keys()]; }
}
const storage = new FakeStorage();
globalThis.window = { localStorage: storage };

const {
  setChartScope, currentChartScope, chartScopeKey, sweepLegacyKeys,
  LEGACY_KEYS, ANON_SCOPE, __resetChartScope,
} = await import('../src/lib/chart/chart-scope.mjs');
const { loadDrawings, saveDrawings } = await import('../src/lib/chart/chart-drawing-store.mjs');
const { loadIndicators, saveIndicators, loadView, saveView, DEFAULT_VIEW, DEFAULT_ACTIVE }
  = await import('../src/lib/chart/chart-settings.mjs');

const USER_A = 'user_2aaaaaaaaaaaaaaaaaaaaaaaaa';
const USER_B = 'user_2bbbbbbbbbbbbbbbbbbbbbbbbb';
const signIn = (id) => setChartScope(id, { resolved: true });
const signOut = () => setChartScope(null, { resolved: true });
const unresolved = () => setChartScope(null, { resolved: false });

// ⚠️ SHAPED LIKE A REAL DRAWING, because coerceDrawing discards anything that is not, and a
// discarded fixture makes every "the other account sees nothing" assertion pass for the wrong
// reason.
const line = (price, id) => ({ id, type: 'horizontal', points: [{ time: 1, price }] });
const priceOf = (d) => d?.points?.[0]?.price;

// ── TEST 1 + 2: B must not receive A's drawings or indicators ───────────────
sec('⚠️ TEST 1 & 2 — USER B DOES NOT RECEIVE USER A\'S STATE');
{
  storage.map.clear(); __resetChartScope();

  signIn(USER_A);
  saveDrawings('NVDA', [line(210, 'a1'), line(220, 'a2')]);
  saveIndicators([{ key: 'rsi-1', id: 'rsi', params: {}, color: null, visible: true },
    { key: 'ema-1', id: 'ema', params: {}, color: null, visible: true }]);
  saveView({ ...DEFAULT_VIEW, chartType: 'Line', logScale: true });
  const aDrawings = loadDrawings('NVDA');
  check('user A saved two NVDA drawings', aDrawings.length === 2, String(aDrawings.length));

  signIn(USER_B);
  const bDrawings = loadDrawings('NVDA');
  check('⚠️ TEST 1: user B opens NVDA and sees NO drawings', bDrawings.length === 0,
    JSON.stringify(bDrawings));
  const bInd = loadIndicators();
  check('⚠️ TEST 2: user B gets the DEFAULT indicators, not user A\'s',
    JSON.stringify(bInd) === JSON.stringify(DEFAULT_ACTIVE.map((d) => ({ ...d }))), JSON.stringify(bInd));
  check('…and the default view, not user A\'s Line/logScale',
    loadView().chartType === DEFAULT_VIEW.chartType && loadView().logScale === false);
}

// ── TEST 3: A signs back in and gets A's state ──────────────────────────────
sec('⚠️ TEST 3 — USER A SIGNS BACK IN AND GETS USER A\'S STATE');
{
  signIn(USER_A);
  const back = loadDrawings('NVDA');
  check('user A\'s two NVDA drawings return', back.length === 2, String(back.length));
  const prices = back.map(priceOf).sort((x, y) => x - y);
  check('…with the same prices, 210 and 220', prices[0] === 210 && prices[1] === 220, JSON.stringify(prices));
  const ind = loadIndicators().map((i) => i.id).sort();
  check('…and user A\'s indicators', ind.join(',') === 'ema,rsi', ind.join(','));
  check('…and user A\'s view', loadView().chartType === 'Line' && loadView().logScale === true,
    JSON.stringify({ chartType: loadView().chartType, logScale: loadView().logScale }));
}

// ── TEST 4: independent saves for the same ticker ───────────────────────────
sec('⚠️ TEST 4 — BOTH ACCOUNTS HOLD DIFFERENT STATE FOR THE SAME TICKER');
{
  signIn(USER_B);
  saveDrawings('NVDA', [line(999, 'b1')]);
  saveIndicators([{ key: 'macd-1', id: 'macd', params: {}, color: null, visible: true }]);

  signIn(USER_A);
  const a = loadDrawings('NVDA');
  check('user A still has exactly two drawings', a.length === 2, String(a.length));
  check('…and none of them is user B\'s 999', !a.some((d) => priceOf(d) === 999));
  check('…and user A\'s indicators are untouched',
    loadIndicators().map((i) => i.id).sort().join(',') === 'ema,rsi');

  signIn(USER_B);
  const b = loadDrawings('NVDA');
  check('user B still has exactly one drawing', b.length === 1, String(b.length));
  check('…and it is user B\'s own', priceOf(b[0]) === 999, JSON.stringify(priceOf(b[0])));
  check('…and user B\'s indicator is macd', loadIndicators().map((i) => i.id).join(',') === 'macd');
  // ⚠️ SEPARATE KEYS, NOT A SHARED ONE WITH A FILTER. Proven from the storage itself.
  const nvdaKeys = storage.keys.filter((x) => x.startsWith('cp_chart_drawings'));
  check('⚠️ the two accounts occupy DIFFERENT storage keys', nvdaKeys.length === 2, nvdaKeys.join(' | '));
  check('…each naming its own Clerk id',
    nvdaKeys.some((x) => x.includes(USER_A)) && nvdaKeys.some((x) => x.includes(USER_B)));
}

// ── TEST 5: the identity changes while the chart is mounted ─────────────────
sec('⚠️ TEST 5 — SWITCHING ACCOUNT MID-SESSION SWAPS THE SOURCE OF TRUTH');
{
  // The component stays mounted; only the scope moves. What the stores return must move with it,
  // which is what makes CPChart's scope-keyed effects load the right account.
  signIn(USER_A);
  const before = loadDrawings('NVDA').length;
  const r = signIn(USER_B);
  check('the scope reports that it changed', r.changed === true);
  check('…and names the new user', r.scope === `u:${USER_B}`, r.scope);
  const after = loadDrawings('NVDA').length;
  check('⚠️ the same call now returns the OTHER account\'s drawings', before === 2 && after === 1,
    `${before} -> ${after}`);
  check('re-resolving the SAME user reports no change', signIn(USER_B).changed === false);
}

// ── TEST 6: a brand-new account inherits nothing ────────────────────────────
sec('⚠️ TEST 6 — A NEW ACCOUNT GETS DEFAULTS, NEVER LEGACY STATE');
{
  storage.map.clear(); __resetChartScope();
  // legacy unscoped state, exactly as it exists in real browsers today
  storage.setItem('cp_chart_drawings', JSON.stringify({
    v: 1, symbols: { NVDA: [line(777, 'legacy')] }, order: ['NVDA'] }));
  storage.setItem('cp_chart_indicators', JSON.stringify({
    v: 2, items: [{ key: 'legacy-1', id: 'rsi', params: {}, color: null, visible: true }] }));
  check('legacy keys exist before anyone signs in',
    storage.getItem('cp_chart_drawings') !== null);

  const fresh = 'user_2ccccccccccccccccccccccccc';
  signIn(fresh);
  check('⚠️ TEST 6: the new account sees NO drawings', loadDrawings('NVDA').length === 0);
  check('…and the DEFAULT indicators',
    JSON.stringify(loadIndicators()) === JSON.stringify(DEFAULT_ACTIVE.map((d) => ({ ...d }))));
  // ⚠️ AND THE LEGACY KEY IS GONE, NOT JUST IGNORED. Ownership cannot be proven, so it is deleted
  // rather than left for the next account to inherit.
  check('⚠️ the legacy unscoped keys are swept on first sign-in',
    LEGACY_KEYS.every((key) => storage.getItem(key) === null),
    LEGACY_KEYS.filter((key) => storage.getItem(key) !== null).join(', '));
}

// ── TEST 7: tickers stay independent within one account ─────────────────────
sec('⚠️ TEST 7 — TICKERS REMAIN INDEPENDENT INSIDE ONE ACCOUNT');
{
  storage.map.clear(); __resetChartScope();
  signIn(USER_A);
  saveDrawings('NVDA', [line(210, 'n1')]);
  saveDrawings('AAPL', [line(150, 'p1'), line(160, 'p2')]);
  check('NVDA keeps its own one drawing', loadDrawings('NVDA').length === 1);
  check('AAPL keeps its own two', loadDrawings('AAPL').length === 2);
  check('…and NVDA did not gain AAPL\'s prices',
    !loadDrawings('NVDA').some((d) => priceOf(d) === 150 || priceOf(d) === 160));
  check('a ticker never touched is empty', loadDrawings('TSLA').length === 0);
}

// ── TEST 8: signing out does not donate state to anyone ─────────────────────
sec('⚠️ TEST 8 — LOGOUT DOES NOT MAKE ONE ACCOUNT\'S STATE THE DEFAULT');
{
  storage.map.clear(); __resetChartScope();
  signIn(USER_A);
  saveDrawings('NVDA', [line(210, 'a1')]);

  signOut();
  check('a signed-out visitor sees NO drawings', loadDrawings('NVDA').length === 0);
  check('…and is in the anon namespace, not user A\'s', currentChartScope() === ANON_SCOPE);
  saveDrawings('NVDA', [line(1, 'anon1')]);

  signIn(USER_B);
  check('⚠️ user B inherits neither user A\'s nor the signed-out state',
    loadDrawings('NVDA').length === 0, JSON.stringify(loadDrawings('NVDA')));

  signIn(USER_A);
  check('user A\'s own state survived all of it', loadDrawings('NVDA').length === 1);
  check('…and is still user A\'s value', priceOf(loadDrawings('NVDA')[0]) === 210);
}

// ── the refusal window, and the no-fallback rule ────────────────────────────
sec('⚠️ WHILE THE IDENTITY IS UNKNOWN, NOTHING IS READ OR WRITTEN');
{
  storage.map.clear(); __resetChartScope();
  unresolved();
  check('the scope is null before Clerk answers', currentChartScope() === null);
  check('…so no key can be built', chartScopeKey('cp_chart_drawings') === null);
  saveDrawings('NVDA', [line(42, 'ghost')]);
  check('⚠️ a write during the unknown window is DROPPED, not guessed into a namespace',
    storage.keys.length === 0, storage.keys.join(', '));
  check('…and a read returns defaults', loadDrawings('NVDA').length === 0);

  // ⚠️ NO FALLBACK. A user with nothing saved gets defaults, never another namespace's contents.
  signIn(USER_A);
  saveDrawings('NVDA', [line(210, 'a1')]);
  signIn(USER_B);
  check('⚠️ user B with no saved NVDA state gets the DEFAULT, not user A\'s',
    loadDrawings('NVDA').length === 0);
  const keyA = (() => { signIn(USER_A); return chartScopeKey('cp_chart_drawings'); })();
  const keyB = (() => { signIn(USER_B); return chartScopeKey('cp_chart_drawings'); })();
  check('the two keys are different strings', keyA !== keyB, `${keyA} vs ${keyB}`);
  check('⚠️ and neither is the legacy unscoped key',
    keyA !== 'cp_chart_drawings' && keyB !== 'cp_chart_drawings');
}

// ── the identity is the Clerk id, not something mutable ─────────────────────
sec('⚠️ THE NAMESPACE IS THE CLERK USER ID');
{
  __resetChartScope();
  signIn(USER_A);
  const key = chartScopeKey('cp_chart_drawings');
  check('the key contains the Clerk user id', key.includes(USER_A), key);
  // ⚠️ EMAIL, USERNAME AND DISPLAY NAME ARE ALL MUTABLE and two of them can be re-pointed at a
  // different person. Only the immutable id may namespace state.
  for (const mutable of ['bcoghill88', 'info@catalystpit.com', 'Brad']) {
    check(`…and not "${mutable}"`, !key.includes(mutable));
  }
}

// ── every module actually routes through the scope ──────────────────────────
sec('⚠️ EVERY CHART STORE GOES THROUGH THE SCOPE');
{
  const fs = await import('node:fs');
  const files = [
    'src/lib/chart/chart-drawing-store.mjs',
    'src/lib/chart/chart-settings.mjs',
    'src/lib/chart/evidence-visibility.mjs',
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    check(`${f.split('/').pop()} imports the scope`, /chartScopeKey/.test(src));
    // ⚠️ THE REGRESSION GUARD. A bare KEY in a storage call is the original bug returning.
    const bare = /localStorage\.(get|set)Item\(\s*(KEY|VIEW_KEY|FAVORITES_KEY|TOOL_DEFAULTS_KEY)\b/.test(src);
    check(`…and never touches storage with an unscoped key`, !bare);
  }
  const chart = fs.readFileSync('src/components/chart/CPChart.jsx', 'utf8');
  check('⚠️ CPChart resolves the signed-in user', /useUser\(\)/.test(chart));
  check('…and hands the Clerk id to the scope', /setChartScope\(user\?\.id/.test(chart));
  // ⚠️ THE SECOND HALF OF THE BUG. Loaders keyed on mount alone kept serving the previous
  // account's state through React even once the keys were namespaced.
  for (const loader of ['loadToolDefaults', 'loadVisibility']) {
    const re = new RegExp(loader + '\\(\\)\\); \\}, \\[scope\\]');
    check(`${loader} reloads when the account changes`, re.test(chart));
  }
  check('indicators and view reload on the account, not on mount',
    /setActive\(loadIndicators\(\)\);\s*\n\s*setView\(loadView\(\)\);\s*\n\s*\}, \[scope\]\)/.test(chart));
  check('drawings depend on BOTH the symbol and the account', /\}, \[sym, scope\]\)/.test(chart));
  check('⚠️ no loader is keyed on mount alone any more',
    !/loadIndicators\(\)\); setView\(loadView\(\)\); \}, \[\]\)/.test(chart));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
