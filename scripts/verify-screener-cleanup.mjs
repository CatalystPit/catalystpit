// SCREENER CLASSIFICATION OPTIONS, FILTER AVAILABILITY, AND THE DARK-MODE SELECTED PILL.
//
//   node scripts/verify-screener-cleanup.mjs [--mutate=<mode>] [--live]
//
// ⚠️ THE CONTRAST ASSERTIONS COMPUTE A RATIO FROM THE ACTUAL CSS CUSTOM PROPERTIES, they do not
// check that a token is "used". The bug being prevented rendered white text on a near-white chip
// at 1.12:1 while every name in the source read perfectly sensibly, so only the arithmetic catches
// it. `--live` additionally runs the filters against the real database.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const { readFile } = await import('node:fs/promises');
const { toOptions, isUsableClassification, prettyClassification } = await import('../src/lib/screener-taxonomy.mjs');

// ── CONTRAST MATHS (WCAG relative luminance) ────────────────────────────────
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = (h) => { const [r, g, b] = hex(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const shared = await readFile(new URL('../src/lib/cp-shared.jsx', import.meta.url), 'utf8');
// The two palettes, in source order: light first, dark second.
const tokenIn = (block, name) => (block.match(new RegExp(`--cp-${name}:(#[0-9A-Fa-f]{6})`)) || [])[1];
// ⚠️ SPLIT AT THE START OF THE DARK PALETTE, NOT AT ITS --cp-ink. A first version split on
// `--cp-ink:#EEF3EF`, which sits several lines BELOW `--cp-bg` inside the same block — so every
// token declared earlier in dark mode read as undefined and the contrast maths threw.
const darkStart = shared.indexOf('--cp-bg:#0E1512');
const lightBlock = shared.slice(0, darkStart);
const darkBlock = shared.slice(darkStart);

L('=== ⚠️ PART 3: THE DARK-MODE SELECTED PILL IS NOT WHITE ===');
{
  const t = (block, n) => tokenIn(block, n);
  const lightSel = mut('inkbg') ? t(lightBlock, 'ink') : t(lightBlock, 'selBg');
  const darkSel = mut('inkbg') ? t(darkBlock, 'ink') : t(darkBlock, 'selBg');
  const lightFg = mut('inkbg') ? '#FFFFFF' : t(lightBlock, 'selFg');
  const darkFg = mut('inkbg') ? '#FFFFFF' : t(darkBlock, 'selFg');

  L(`  light selected: bg ${lightSel} fg ${lightFg} -> ${ratio(lightSel, lightFg).toFixed(2)}:1`);
  L(`  dark  selected: bg ${darkSel} fg ${darkFg} -> ${ratio(darkSel, darkFg).toFixed(2)}:1`);

  ok('both themes define a selected background', Boolean(lightSel && darkSel), `${lightSel} / ${darkSel}`);
  ok('⚠️ the DARK selected pill is readable (>= 4.5:1)',
    mut('inkbg') ? false : ratio(darkSel, darkFg) >= 4.5,
    `${ratio(darkSel, darkFg).toFixed(2)}:1 — the old rule gave 1.12:1, a white blob`);
  ok('light stays readable', ratio(lightSel, lightFg) >= 4.5, `${ratio(lightSel, lightFg).toFixed(2)}:1`);
  ok('⚠️ light mode is UNCHANGED from what it already rendered',
    lightSel.toUpperCase() === tokenIn(lightBlock, 'ink').toUpperCase() && lightFg.toUpperCase() === '#FFFFFF',
    'the defect was dark-mode only; light must not move');

  // The chip must separate from the page it sits on, or "selected" is invisible for a different reason.
  const darkPage = tokenIn(darkBlock, 'bg'), lightPage = tokenIn(lightBlock, 'white');
  ok('⚠️ the dark chip separates from the page behind it (>= 3:1)',
    ratio(darkSel, darkPage) >= 3, `${ratio(darkSel, darkPage).toFixed(2)}:1 vs ${darkPage}`);
  ok('…and the light chip does too', ratio(lightSel, lightPage) >= 3, `${ratio(lightSel, lightPage).toFixed(2)}:1`);

  // UNSELECTED must remain distinguishable from selected in both themes.
  for (const [name, block, page] of [['light', lightBlock, lightPage], ['dark', darkBlock, tokenIn(darkBlock, 'white')]]) {
    const sel = tokenIn(block, 'selBg');
    ok(`${name}: selected is clearly distinct from unselected`, ratio(sel, page) >= 3,
      `${ratio(sel, page).toFixed(2)}:1`);
  }

  // ⚠️ NO CONSUMER MAY GO BACK TO USING A FOREGROUND TOKEN AS A BACKGROUND.
  const consumers = [
    ['app/screener/ScreenerClient.jsx', 'Screener category pills'],
    ['components/scan/PitScanPanel.jsx', 'Pit Scan tab'],
    ['app/terminal/TerminalClient.jsx', 'Terminal tabs'],
    ['app/politicians/[slug]/PoliticianDetail.jsx', 'Politician filters'],
  ];
  for (const [f, what] of consumers) {
    const src = (await readFile(new URL(`../src/${f}`, import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(`${what}: selected state uses the semantic token`,
      mut('inkbg') ? false : /C\.selBg/.test(src), f);
    ok(`  …${what}: no \`background: … ? C.ink\` remains`,
      !/background:[^,;}]*\?\s*C\.ink\b/.test(src), f);
  }
}

L('\n=== PART 1: CLASSIFICATION OPTIONS COME FROM THE DATA ===');
{
  // Garbage must not reach a dropdown.
  for (const bad of ['', '   ', 'N/A', 'n/a', 'None', 'null', 'unknown', '---', '123', '!!', null, undefined, 42]) {
    ok(`rejected: ${JSON.stringify(bad)}`, !isUsableClassification(bad));
  }
  for (const good of ['PHARMACEUTICAL PREPARATIONS', 'Technology', 'BLANK CHECKS', 'Real Estate']) {
    ok(`accepted: ${good}`, isUsableClassification(good));
  }

  const raw = ['PHARMACEUTICAL PREPARATIONS', 'BLANK CHECKS', '', 'N/A', 'REAL ESTATE INVESTMENT TRUSTS', 'pharmaceutical preparations', '   ', 'STATE COMMERCIAL BANKS'];
  const opts = toOptions(raw);
  ok('blank and garbage entries are dropped', opts.length === 4, JSON.stringify(opts.map((o) => o.label)));
  ok('⚠️ no duplicate labels', new Set(opts.map((o) => o.label)).size === opts.length);
  ok('…and case-variants collapse to ONE entry, not two',
    opts.filter((o) => /Pharmaceutical/i.test(o.label)).length === 1);
  ok('options are sorted for a usable dropdown',
    opts.map((o) => o.label).join('|') === [...opts.map((o) => o.label)].sort((a, b) => a.localeCompare(b)).join('|'));
  ok('⚠️ each option filters by its EXACT stored value, not a substring token',
    opts.every((o) => raw.some((r) => r === o.cond.contains)),
    'the old options matched on fragments like BANK, catching neighbouring classifications');
  ok('labels are readable without changing what is filtered',
    opts.find((o) => o.cond.contains === 'REAL ESTATE INVESTMENT TRUSTS').label === 'Real Estate Investment Trusts');
  ok('acronyms survive title-casing', prettyClassification('REIT SERVICES') === 'REIT Services');
  ok('⚠️ normalisation never merges genuinely different classifications', (() => {
    const two = toOptions(['OIL & GAS FIELD SERVICES', 'OIL & GAS EXTRACTION']);
    return two.length === 2 && two[0].cond.contains !== two[1].cond.contains;
  })());
}

L('\n=== PART 2: FILTER AVAILABILITY ===');
{
  const { FILTERS } = await import('../src/lib/screener-filters.js');
  ok('⚠️ Inst Own % is enabled — it has a real column the ingest fills',
    mut('disableinst') ? false : FILTERS.instOwnPct.available === true);
  ok('…and it is a plain range, so buildConds compiles it generically',
    FILTERS.instOwnPct.type === 'range' && FILTERS.instOwnPct.col === 'instOwnPct' && !FILTERS.instOwnPct.live);

  // ⚠️ THE OTHERS STAY DISABLED. Each was checked against the schema: the column does not exist,
  // so there is nothing to enable without inventing a data pipeline or a number.
  const stillOff = ['analystRec', 'earningsDate', 'pFcf', 'targetPrice', 'epsGrowthNextYr',
    'epsGrowthNext5y', 'earningsSurprise', 'revenueSurprise', 'etfType', 'aum', 'expenseRatio'];
  for (const k of stillOff) {
    ok(`${k} remains disabled (no column)`, FILTERS[k] && !FILTERS[k].available, k);
  }
  ok('no filter claims availability without a column or a live source',
    Object.entries(FILTERS).filter(([, f]) => f.available && !f.col && !f.live && !f.membersKey).length === 0);
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE: THE FILTERS ACTUALLY FILTER ===');
  const { db } = await import('../src/lib/db.js');
  const { sql } = await import('drizzle-orm');
  const { buildConds } = await import('../src/lib/screener-filters.js');
  const { and } = await import('drizzle-orm');
  const { screenerStocks } = await import('../src/lib/schema.js');

  const count = async (active) => {
    const conds = buildConds(active);
    const q = db.select({ n: sql`count(*)`.mapWith(Number) }).from(screenerStocks);
    const [{ n }] = conds.length ? await q.where(and(...conds)) : await q;
    return n;
  };
  const rowsFor = async (active, cols) => {
    const conds = buildConds(active);
    const q = db.select(cols).from(screenerStocks);
    return conds.length ? await q.where(and(...conds)).limit(25) : await q.limit(25);
  };

  const all = await count({});
  ok('unfiltered returns the whole universe', all > 10000, String(all));

  // 4. SECTOR
  const secRows = await rowsFor({ sector: { eq: 'Technology' } }, { ticker: screenerStocks.ticker, sector: screenerStocks.sector });
  ok('⚠️ selecting a sector returns only that sector',
    secRows.length > 0 && secRows.every((r) => r.sector === 'Technology'),
    `${secRows.length} rows, sectors: ${[...new Set(secRows.map((r) => r.sector))].join(',')}`);
  const secCount = await count({ sector: { eq: 'Technology' } });
  ok('…and it narrows the result set', secCount > 0 && secCount < all, `${secCount} of ${all}`);

  // 5. INDUSTRY — using a dataset-derived option, exactly as the dropdown will send it.
  const distinct = await db.execute(sql`
    select industry, count(*)::int n from screener_stocks
     where market_cap > 0 and industry is not null and trim(industry) <> ''
     group by 1 order by n desc limit 1`);
  const topIndustry = (distinct.rows ?? distinct)[0].industry;
  const indRows = await rowsFor({ industry: { contains: topIndustry } }, { ticker: screenerStocks.ticker, industry: screenerStocks.industry });
  ok(`⚠️ selecting industry "${topIndustry}" returns only that industry`,
    indRows.length > 0 && indRows.every((r) => r.industry === topIndustry),
    `${[...new Set(indRows.map((r) => r.industry))].length} distinct in result`);

  // 6. COMBINED
  const comboCount = await count({ sector: { eq: 'Healthcare' }, industry: { contains: 'PHARMACEUTICAL PREPARATIONS' } });
  const secOnly = await count({ sector: { eq: 'Healthcare' } });
  ok('⚠️ combining sector + industry narrows further', comboCount > 0 && comboCount <= secOnly, `${comboCount} <= ${secOnly}`);

  // 9. THE NEWLY ENABLED FILTER ACTUALLY FILTERS
  const instRows = await rowsFor({ instOwnPct: { min: 30 } }, { ticker: screenerStocks.ticker, instOwnPct: screenerStocks.instOwnPct });
  ok('⚠️ Inst Own % >= 30 returns only rows at or above 30',
    instRows.length > 0 && instRows.every((r) => Number(r.instOwnPct) >= 30),
    `${instRows.length} rows, min ${Math.min(...instRows.map((r) => Number(r.instOwnPct))).toFixed(1)}`);
  const instCount = await count({ instOwnPct: { min: 30 } });
  ok('…and narrows the set', instCount > 0 && instCount < all, `${instCount} of ${all}`);

  // 10. A DISABLED FILTER IS IGNORED rather than compiled into broken SQL.
  ok('⚠️ a disabled filter contributes no condition', buildConds({ aum: { min: 1 } }).length === 0);
  ok('clearing filters restores the full set', (await count({})) === all);

  // 1 & 2. THE DROPDOWNS COVER THE DATA.
  const { toOptions: opt } = await import('../src/lib/screener-taxonomy.mjs');
  const secs = await db.execute(sql`select sector v from screener_stocks where market_cap>0 and sector is not null and trim(sector)<>'' group by 1`);
  const inds = await db.execute(sql`select industry v from screener_stocks where market_cap>0 and industry is not null and trim(industry)<>'' group by 1`);
  const secOpts = opt((secs.rows ?? secs).map((r) => r.v), { contains: false });
  const indOpts = opt((inds.rows ?? inds).map((r) => r.v));
  L(`  canonical sectors: ${secOpts.length}   canonical industries: ${indOpts.length}`);
  ok('⚠️ every canonical sector is offered', secOpts.length >= 11, String(secOpts.length));
  ok('⚠️ the industry dropdown covers the dataset, not 27 hand-written entries',
    indOpts.length > 300, `${indOpts.length} options`);
  ok('no blank or garbage option', indOpts.every((o) => o.label.trim().length > 1));
  ok('no duplicate industry label', new Set(indOpts.map((o) => o.label)).size === indOpts.length);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
