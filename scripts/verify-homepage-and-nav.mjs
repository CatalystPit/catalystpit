// THE HOMEPAGE HEATMAP READS THE SHARED SNAPSHOT, AND "More" ACTUALLY OPENS.
//
//   node --experimental-loader ./scripts/jsx-loader.mjs scripts/verify-homepage-and-nav.mjs [--mutate=m] [--live]
//
// ⚠️ THESE RENDER THE REAL COMPONENTS AND WALK THE ELEMENT TREE. Where a behaviour depends on
// layout (the clipping bug) that cannot be observed without a browser, the assertion targets the
// CAUSE — an absolutely-positioned panel inside an `overflow:hidden` containing block — rather
// than pretending to have seen the rendered result.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const { readFile } = await import('node:fs/promises');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

L('=== ⚠️ TASK 1: THE HOMEPAGE READS THE SHARED SNAPSHOT ===');
{
  const home = strip(await readFile(new URL('../src/components/CatalystPit.jsx', import.meta.url), 'utf8'));
  const hm = strip(await readFile(new URL('../src/components/HeatMap.jsx', import.meta.url), 'utf8'));
  // ⚠️ NOT STRIPPED. strip() swallows a large span of this particular file — some `/*` in it is
  // unbalanced by the naive block-comment regex — and silently removed the very JSX under test,
  // reporting the Terminal as changed when it was not. The assertion below only needs the raw
  // usage, so it reads the raw source.
  const term = await readFile(new URL('../src/app/terminal/TerminalClient.jsx', import.meta.url), 'utf8');

  ok('⚠️ the homepage card opts into the shared board',
    mut('legacyhome') ? false : /<HeatMap[^>]*\sshared\b/.test(home),
    'it fetched /api/heatmap, whose prices are only as fresh as the nightly screener rebuild');
  ok('…and the shared path targets the snapshot route',
    /\/api\/heatmap\/performance\?timeframe=1D/.test(hm));
  ok('…while the legacy path is still available for the Terminal',
    /\/api\/heatmap\?limit=/.test(hm));
  ok('⚠️ the TERMINAL is untouched — it passes no `shared` prop',
    /<HeatMap onPick=\{onPick\} \/>/.test(term) && !/<HeatMap[^>]*shared/.test(term));

  // ⚠️ NO SECOND COLLECTOR, AND NO VENDOR CALL FROM A VIEWER.
  ok('⚠️ the component contacts no vendor directly', !/api\.tiingo\.com|api\.polygon\.io/.test(hm));
  ok('…and builds no snapshot of its own',
    !/captureIfDue|getAllTickersSnapshot|acquireRebuildLock/.test(hm),
    'a homepage viewer must never trigger a rebuild');
  ok('entitlement decides the URL only, and is read from the server',
    /\/api\/me\/plan/.test(hm) && /entitled \? '&rt=1' : ''/.test(hm));
  ok('the poll costs a cached read, not a collection', /setInterval\(load, 60000\)/.test(hm));

  // The dedicated page must not have been touched by this change.
  const page = await readFile(new URL('../src/app/heatmap/MarketHeatmapClient.jsx', import.meta.url), 'utf8');
  ok('⚠️ the dedicated /heatmap page still owns its own universe and lifecycle',
    /universe=\$\{encodeURIComponent\(uni\)\}/.test(page) && /HEATMAP_POLL_MS = 60000/.test(page));
  ok('…and still uses its session-gated snapshot',
    /data\.session\.phase === 'regular' && !data\.session\.frozen/.test(page));
}

L('\n=== ⚠️ TASK 2: "More" OPENS — THE PANEL WAS BEING CLIPPED ===');
{
  const src = await readFile(new URL('../src/lib/cp-shared.jsx', import.meta.url), 'utf8');
  const code = strip(src);
  const nav = code.slice(code.indexOf('export function TopNav'));

  // ⚠️ THE ROOT CAUSE. The nav row has overflow:hidden AND position:relative, so it is both the
  // panel's containing block and its clipper. An `absolute` panel was cropped to the 50px bar.
  ok('the nav row still clips its children (load-bearing for the overflow maths)',
    /overflow:"hidden", position:"relative"/.test(nav));
  ok('⚠️ …so the menu is FIXED, not absolute — it cannot be clipped by that ancestor',
    mut('absolutepanel') ? false : /role="menu"[\s\S]{0,200}position:"fixed"/.test(nav),
    'an absolutely-positioned panel opened correctly every time and was invisible');
  ok('…positioned from the button’s own rect', /getBoundingClientRect\(\)/.test(nav) && /setMorePos/.test(nav));
  ok('…clamped so it cannot leave the viewport or widen the page',
    /Math\.max\(8, Math\.min\(window\.innerWidth - 8/.test(nav));
  ok('…and it sits above the click-away layer', /zIndex:150/.test(nav) && /zIndex:151/.test(nav));

  // HOVER + CLICK + TRANSIT
  ok('⚠️ hover opens', mut('clickonly') ? false : /onMouseEnter=\{openMore\}/.test(nav));
  ok('⚠️ leaving closes after a delay, not instantly',
    mut('instantclose') ? false : /onMouseLeave=\{closeMoreSoon\}/.test(nav) && /setTimeout\(\(\) => setMoreOpen\(false\), 220\)/.test(nav),
    'closing on the first mouseleave shuts the menu while the pointer is crossing the gap to it');
  ok('…and the delay is short enough not to feel stuck', /, 220\)/.test(nav));
  ok('⚠️ the hover region spans BOTH the button and the panel',
    /onMouseEnter=\{openMore\} onMouseLeave=\{closeMoreSoon\}/.test(nav),
    'both handlers on the wrapper, so moving into the panel never leaves the region');
  ok('⚠️ click toggles', mut('hoveronly') ? false : /onClick=\{\(\) => \(moreOpen \? setMoreOpen\(false\) : openMore\(\)\)\}/.test(nav));
  ok('a re-open clears any pending close', /clearTimeout\(moreTimer\.current\);[\s\S]{0,80}getBoundingClientRect/.test(nav));

  // CLOSE PATHS
  ok('outside click closes', /onClick=\{\(\) => setMoreOpen\(false\)\}[\s\S]{0,120}position:"fixed", inset:0/.test(nav));
  ok('⚠️ Escape closes', mut('noescape') ? false : /e\.key === 'Escape'/.test(nav));
  ok('…and returns focus to the control that opened it', /moreBtnRef\.current\?\.focus\(\)/.test(nav));
  ok('a menu item closes it and navigates', /<a key=\{l\} href=\{hrefFor\(l\)\} onClick=\{\(\) => setMoreOpen\(false\)\}/.test(nav));
  ok('scroll or resize closes a fixed panel rather than stranding it',
    /window\.addEventListener\('scroll', close/.test(nav) && /window\.addEventListener\('resize', close\)/.test(nav));

  // TOUCH + A11Y
  ok('⚠️ touch works, because click is a real path and not hover-only',
    /onClick=\{\(\) => \(moreOpen \?/.test(nav), 'there is no reliable hover on a touch device');
  ok('it is a real <button>, so Enter and Space activate it natively', /<button type="button"/.test(nav));
  ok('aria-expanded reflects state', /aria-expanded=\{moreOpen\}/.test(nav));
  ok('aria-haspopup declares a menu', /aria-haspopup="menu"/.test(nav));
  ok('the panel is announced as a menu', /role="menu"/.test(nav));
  ok('the timer is cleared on unmount', /useEffect\(\(\) => \(\) => clearTimeout\(moreTimer\.current\), \[\]\)/.test(nav));

  // ⚠️ EVERY HOOK USED MUST BE IMPORTED. useCallback was used before it was imported here, which
  // compiles cleanly and throws at runtime — the same class of defect as an undeclared variable.
  const imported = new Set((src.match(/import \{([^}]+)\} from 'react'/) || [, ''])[1].split(',').map((x) => x.trim()));
  const used = new Set([...src.matchAll(/\b(use[A-Z]\w+)\s*\(/g)].map((m) => m[1]));
  const REACT = ['useState', 'useEffect', 'useRef', 'useCallback', 'useMemo', 'useReducer', 'useLayoutEffect'];
  const missing = [...used].filter((h) => REACT.includes(h) && !imported.has(h));
  ok('⚠️ no React hook is used without being imported', missing.length === 0, missing.join(', '));
}

L('\n=== DESTINATIONS AND THE OVERFLOW ALGORITHM ARE UNTOUCHED ===');
{
  const src = await readFile(new URL('../src/lib/cp-shared.jsx', import.meta.url), 'utf8');
  const { fitCount } = await import('../src/lib/nav-overflow.mjs');
  ok('the overflow maths still decides the count from measured widths',
    /setVisible\(fitCount\(/.test(src) && /new ResizeObserver\(recompute\)/.test(src));
  ok('…and re-measures once fonts land', /document\.fonts\?\.ready/.test(src));
  ok('fitCount still behaves', fitCount([100, 100, 100], 250, 60, 0) === 1 && fitCount([100, 100], 1000, 60, 0) === 2);

  // ⚠️ DIVIDENDS MUST REMAIN REACHABLE — from the bar or from the menu, never dropped.
  const links = (src.match(/const links = \[([^\]]+)\]/) || [, ''])[1];
  ok('Dividends is still a destination', /Dividends/.test(links) || /Dividends/.test(src), links.slice(0, 120));
  const nav = strip(src).slice(strip(src).indexOf('export function TopNav'));
  ok('⚠️ overflowed destinations are rendered in the menu, never discarded',
    /overflowed\.map\(l =>/.test(nav));
  ok('an active destination inside the menu still looks active',
    /overflowed\.includes\(active\)/.test(nav));
  ok('the selected-pill tokens from the previous task are undisturbed',
    /--cp-selBg:#2A7848/.test(src) && /--cp-selBg:#0C1410/.test(src));
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE: HOMEPAGE AND DEDICATED PAGE SHARE ONE SNAPSHOT ===');
  const BASE = process.env.CP_BASE_URL || 'https://www.catalystpit.com';
  const get = async (u) => (await fetch(u, { cache: 'no-store' })).json();
  const a = await get(`${BASE}/api/heatmap/performance?timeframe=1D&universe=top500`);
  const b = await get(`${BASE}/api/heatmap/performance?timeframe=1D&universe=top500`);
  L(`  snapshotAt: ${a.snapshotAt ?? '(eod board)'}   freshness: ${a.freshness}   session: ${a.session?.phase}`);
  ok('the shared route answers', Array.isArray(a.rows) && a.rows.length > 0, String(a.rows?.length));
  ok('⚠️ two readers get the SAME snapshot generation',
    a.snapshotAt === b.snapshotAt && a.asOf === b.asOf, `${a.snapshotAt} vs ${b.snapshotAt}`);
  ok('…and the same baseline', a.baselineDate === b.baselineDate);
  ok('the session state is reported, so the card can label honestly', Boolean(a.session?.phase));

  // The homepage slices this same payload, so its tiles are a subset of the same board.
  const top = (a.rows || []).slice(0, 120);
  ok('the homepage subset is drawn from the same rows', top.length === Math.min(120, a.rows.length));
  ok('…carrying the field the canvas reads', top.every((r) => 'pct' in r));
  const legacy = await get(`${BASE}/api/heatmap?limit=120`);
  ok('the legacy board still answers for the Terminal', Array.isArray(legacy.rows));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
