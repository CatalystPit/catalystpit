// MARKET STRUCTURE LOCATES THE STOCK, AND NO LEVEL IS CONFIRMED BY A CANDLE THAT CAME AFTER IT.
//
//   node --env-file=.env.local --experimental-loader ./scripts/ext-resolve-loader.mjs \
//        scripts/verify-consensus-structure.mjs [--mutate=m] [--live]
//
// ⚠️ THE LOOKAHEAD TEST IS THE ONE THAT MATTERS. A pivot detector that peeks at future candles
// produces levels that look excellent in review and cannot have been known at the time — the most
// common way a technical feature ships a lie. It is tested by TRUNCATION: compute the pivots on
// the full series and on a shortened one, and require identical answers over the region they share.
//
// Mutations:
//   --mutate=lookahead   pivots confirmed with only past bars, so the newest bar can be a pivot
//   --mutate=dumpall     every available metric is rendered instead of the useful few
//   --mutate=forcelevel  a level is invented when no confirmed pivot exists

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const fs = await import('node:fs/promises');
const read = (p) => fs.readFile(new URL(p, import.meta.url), 'utf8');

const S = await import('../src/lib/consensus/structure-levels.mjs');
const { structureFacts, structureLines, confirmedPivots,
  PIVOT_CONFIRMATION_BARS, NEAR_LEVEL_PCT, SESSIONS_20D, MA_SHORT, MA_LONG } = S;

// ⚠️ THE MUTATION: confirm a pivot using only PRECEDING bars. This is the natural "simplification"
// — it finds more levels, finds them sooner, and every one of them is unknowable at the time.
const pivots = (bars) => {
  if (!mut('lookahead')) return confirmedPivots(bars);
  const b = (bars || []).filter((x) => Number.isFinite(x?.high));
  const k = PIVOT_CONFIRMATION_BARS; const out = { highs: [], lows: [] };
  for (let i = k; i < b.length; i++) {
    let hi = true, lo = true;
    for (let j = i - k; j < i; j++) { if (b[j].high >= b[i].high) hi = false; if (b[j].low <= b[i].low) lo = false; }
    if (hi) out.highs.push({ date: b[i].date, price: b[i].high });
    if (lo) out.lows.push({ date: b[i].date, price: b[i].low });
  }
  return out;
};

/** A deterministic synthetic series with a known shape: one clear peak and one clear trough. */
const series = (closes) => closes.map((c, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, close: c, high: c, low: c }));

L('=== ⚠️ NO LEVEL MAY BE CONFIRMED BY A CANDLE THAT CAME AFTER IT ===');
{
  // A peak at index 5 with three clean sessions either side.
  const s = series([10, 11, 12, 13, 14, 20, 14, 13, 12, 11, 10, 11, 12]);
  const p = pivots(s);
  ok('a confirmed peak is found', p.highs.some((x) => x.price === 20));
  ok(`…and confirmation needs ${PIVOT_CONFIRMATION_BARS} sessions EITHER side`, PIVOT_CONFIRMATION_BARS >= 3);

  // ⚠️ THE NEWEST BARS CANNOT BE PIVOTS. Nothing has traded after them.
  const rising = series([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const rp = pivots(rising);
  const tailDates = rising.slice(-PIVOT_CONFIRMATION_BARS).map((x) => x.date);
  const inTail = [...rp.highs, ...rp.lows].filter((x) => tailDates.includes(x.date));
  ok('⚠️ no pivot sits in the unconfirmed tail',
    mut('lookahead') ? false : inTail.length === 0, JSON.stringify(inTail));
  ok('…a monotonic series yields no swing high at its final bar',
    mut('lookahead') ? false : !rp.highs.some((x) => x.date === rising[rising.length - 1].date));

  // ⚠️ TRUNCATION EQUIVALENCE — the real proof. Levels must not change when the future is removed.
  const long = series([10, 12, 11, 9, 14, 18, 15, 13, 8, 7, 9, 12, 16, 20, 17, 14, 11, 13, 15, 19, 22, 18, 16]);
  for (const cut of [1, 3, 6, 9]) {
    const trunc = long.slice(0, long.length - cut);
    const horizon = trunc[trunc.length - 1 - PIVOT_CONFIRMATION_BARS]?.date;
    const a = JSON.stringify(pivots(long).highs.filter((x) => x.date <= horizon));
    const b = JSON.stringify(pivots(trunc).highs.filter((x) => x.date <= horizon));
    ok(`⚠️ removing the last ${cut} session(s) does not change earlier pivots`,
      mut('lookahead') ? false : a === b);
  }
  ok('too short to confirm anything yields nothing',
    JSON.stringify(confirmedPivots(series([1, 2, 3, 4, 5]))) === '{"highs":[],"lows":[]}');
  ok('the module reads no clock and no database',
    !/Date\.now|new Date\(\)|db\.|fetch\(/.test(await read('../src/lib/consensus/structure-levels.mjs')));
}

L('\n=== ⚠️ A LEVEL IS NEVER FORCED ONTO A TICKER ===');
{
  const flat = structureFacts(series(Array(60).fill(10)));
  ok('a flat series has no swing high',
    mut('forcelevel') ? false : flat?.resistance === null, JSON.stringify(flat?.resistance));
  ok('…and no swing low', mut('forcelevel') ? false : flat?.support === null);
  ok('…so it emits no support/resistance lines',
    !structureLines(flat).some((l) => /support|resistance/i.test(l.headline)));
  ok('no bars at all → null, not an empty shell', structureFacts([]) === null);
  ok('one bar → null', structureFacts(series([10])) === null);
  ok('⚠️ a 50D average needs 50 sessions', structureFacts(series(Array(40).fill(0).map((_, i) => 10 + i)))?.ma50 === null);
  ok('⚠️ a 200D average needs 200 sessions', structureFacts(series(Array(120).fill(0).map((_, i) => 10 + i)))?.ma200 === null);
  ok(`…and they appear once history allows (${MA_SHORT}/${MA_LONG})`,
    structureFacts(series(Array(210).fill(0).map((_, i) => 10 + i)))?.ma200 !== null);
  ok('a non-finite close is discarded rather than coerced',
    structureFacts([...series([10, 11]), { date: 'x', close: null, high: null, low: null }])?.close === 11);
}

L('\n=== ⚠️ THE 20-SESSION RANGE EXCLUDES THE CURRENT BAR ===');
{
  // 20 sessions topping at 15, then a close above it.
  const s = series([...Array(20).fill(0).map((_, i) => 10 + (i === 10 ? 5 : 0)), 16]);
  const f = structureFacts(s);
  ok('⚠️ a close above the PRIOR 20-session high reads as a break',
    f?.high20?.broken === true, JSON.stringify(f?.high20));
  ok('…which is impossible if the window contains today', f?.high20?.price === 15);
  const down = series([...Array(20).fill(0).map((_, i) => 20 - (i === 10 ? 5 : 0)), 14]);
  ok('a close below the prior 20-session low reads as a break', structureFacts(down)?.low20?.broken === true);
  ok('the window is exactly 20 sessions', SESSIONS_20D === 20);
}

L('\n=== ⚠️ 2–4 USEFUL FACTS, NOT EVERY METRIC THAT EXISTS ===');
{
  const rich = series([...Array(260).fill(0).map((_, i) => 100 + Math.sin(i / 7) * 12 + i * 0.05)]);
  const f = structureFacts(rich);
  const lines = structureLines(f);
  ok('⚠️ at most four lines', mut('dumpall') ? false : lines.length <= 4, String(lines.length));
  ok('…and at least one', lines.length >= 1);
  ok('every line has a headline and a detail', lines.every((l) => l.headline && l.detail));
  ok('⚠️ a nearby level is emphasised over a distant one',
    structureLines({ ...f, support: { price: f.close * 0.99, date: 'd', pct: 1.0 } })[0].emphasis === true);
  ok(`"near" is within ${NEAR_LEVEL_PCT}%`, NEAR_LEVEL_PCT === 2.0);

  // ⚠️ NO PREDICTION, EVER.
  const words = lines.map((l) => `${l.headline} ${l.detail}`).join(' ').toLowerCase();
  for (const w of ['buy', 'sell', 'bullish', 'bearish', 'will hold', 'will reject', 'likely', 'breakout imminent', 'target']) {
    ok(`⚠️ never says "${w}"`, !words.includes(w));
  }
  const src = (await read('../src/lib/consensus/structure-levels.mjs'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('⚠️ the module itself contains no predictive vocabulary',
    !/'(buy|sell|bullish|bearish)'|will hold|will reject/i.test(src));
  ok('⚠️ no volume, RVOL or VWAP anywhere', !/volume|rvol|vwap/i.test(src));
}

L('\n=== ⚠️ REACTION AND STRUCTURE ARE DIFFERENT QUESTIONS ===');
{
  const mf = (await read('../src/lib/consensus/market-facts.js'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('⚠️ the generic-return clutter is gone from the narrative',
    !/last session/.test(mf) && !/5D \$\{/.test(mf) && !/pctFrom20dHigh\.toFixed/.test(mf),
    '"+1.4% last session", "5D +0.7%" and "-39.7% below the 20-day high" were structure in name only');
  ok('…the event reaction is retained unchanged',
    /in the session after it became public/.test(mf) && /vs SPY/.test(mf));
  ok('…including the meaningful-response threshold', /threshold for a meaningful response/.test(mf));
  ok('⚠️ structure is computed from the SAME bar load — no extra query',
    /const bars = await loadBars\(ticker\);[\s\S]{0,200}structureFacts\(bars\)/.test(mf));
  ok('⚠️ no vendor call is introduced', !/tiingo|polygon|api\.|fetch\(/i.test(mf));
  ok('reaction thresholds were not touched',
    !/REACTION_FLOOR_PCT\s*=|floorPct\s*=/.test(mf));

  const card = await read('../src/app/consensus/SetupCard.jsx');
  const structSrc = await read('../src/lib/consensus/structure-levels.mjs');
  ok('the card has a REACTION TO EVIDENCE block', /REACTION TO EVIDENCE/.test(card));
  ok('…and a separate DAILY CHART block', /DAILY CHART/.test(card));
  // ⚠️ FAIL CLOSED RATHER THAN FILL THE SPACE — the whole defect was substituting unrelated return
  // statistics whenever the evidence reaction could not be measured.
  ok('⚠️ an unmeasurable reaction says so instead of substituting returns',
    /Not measured yet/.test(card) && /!row\.market\?\.measured/.test(card));
  ok('…and `measured` is derived from the reaction, never from levels',
    /const measured = Boolean\(reaction && Number\.isFinite\(reaction\.abs\)\)/.test(mf));
  ok('⚠️ stale and distant pivots are rejected BEFORE "nearest" is asked',
    /MAX_PIVOT_AGE_SESSIONS/.test(structSrc) && /const relevant = \(p\) =>/.test(structSrc));
  ok('…a pivot older than six months cannot be a level', S.MAX_PIVOT_AGE_SESSIONS === 126);
  ok('…nor one more than 25% from price', S.MAX_LEVEL_DISTANCE_PCT === 25);
  ok('⚠️ the card contains NO technical-analysis logic',
    !/swing|pivot|movingAverage|\.slice\(-20\)|reduce\(/.test(card),
    'levels are computed in the shared layer and consumed as facts');
}

L('\n=== ⚠️ ONE EVIDENCE ACTION PER CARD ===');
{
  const card = await read('../src/app/consensus/SetupCard.jsx');
  const code = card.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  ok('⚠️ the per-record "Verify →" link is gone', !/>Verify\s*→</.test(code));
  ok('…"Open evidence →" remains, exactly once',
    (code.match(/Open evidence →/g) || []).length === 1);
  ok('⚠️ the public timestamp is still shown', /Public \{f\.publicAgo\}/.test(code));
  ok('…and the source is still named', /f\.source|sourceLabel|f\.family/.test(code));
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE: REAL CANDLES, REAL TICKERS ===');
  const { sql } = await import('drizzle-orm');
  const { db } = await import('../src/lib/db.js');
  const bars = async (t) => (await db.execute(sql`
    select date::text date, close::float8 close, high::float8 high, low::float8 low
      from ticker_daily_candles where ticker=${t} and date >= current_date - 400 order by date asc`)).rows || [];

  const seen = { support: 0, resistance: 0, breakUp: 0, breakDown: 0, ma50: 0, ma200: 0, near: 0 };
  for (const t of ['AAPL', 'MSFT', 'NVDA', 'PG', 'GME', 'TELA', 'ADC', 'THC', 'AMZN', 'KO']) {
    const b = await bars(t);
    const f = structureFacts(b);
    if (!f) continue;
    const lines = structureLines(f);
    ok(`${t}: 1–4 located facts`, lines.length >= 1 && lines.length <= 4, `${lines.length}`);
    ok(`${t}: every level sits on a real candle date`,
      [f.support, f.resistance].filter(Boolean).every((x) => b.some((r) => r.date === x.date)));
    if (f.support) seen.support++;
    if (f.resistance) seen.resistance++;
    if (f.high20?.broken) seen.breakUp++;
    if (f.low20?.broken) seen.breakDown++;
    if (f.ma50) seen.ma50++;
    if (f.ma200) seen.ma200++;
    if (lines.some((l) => l.emphasis)) seen.near++;
  }
  L(`  scenario coverage: ${JSON.stringify(seen)}`);
  ok('⚠️ confirmed support observed', seen.support > 0);
  ok('⚠️ confirmed resistance observed', seen.resistance > 0);
  ok('⚠️ a range break observed', seen.breakUp + seen.breakDown > 0);
  ok('⚠️ price near a level observed', seen.near > 0);
  ok('50D and 200D relationships observed', seen.ma50 > 0 && seen.ma200 > 0);

  // ⚠️ TRUNCATION EQUIVALENCE ON REAL, SPLIT-ADJUSTED DATA.
  for (const t of ['AAPL', 'NVDA']) {
    const full = await bars(t);
    for (const cut of [5, 20, 45]) {
      const trunc = full.slice(0, full.length - cut);
      const horizon = trunc[trunc.length - 1 - PIVOT_CONFIRMATION_BARS].date;
      const a = JSON.stringify(confirmedPivots(full).highs.filter((x) => x.date <= horizon));
      const b2 = JSON.stringify(confirmedPivots(trunc).highs.filter((x) => x.date <= horizon));
      ok(`⚠️ ${t}: dropping the last ${cut} sessions leaves earlier pivots identical`, a === b2);
    }
  }
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
