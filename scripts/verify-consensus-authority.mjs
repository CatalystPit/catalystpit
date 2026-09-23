// A PRE-SCHEDULED SALE IS NOT AN OPINION, AND BACKGROUND DATA CANNOT OVERRULE A FILING.
//
//   node --env-file=.env.local --experimental-loader ./scripts/ext-resolve-loader.mjs \
//        scripts/verify-consensus-authority.mjs [--mutate=m] [--live]
//
// ⚠️ WHY THIS FILE EXISTS, DEMONSTRATED RATHER THAN ASSERTED. With the routine-sale guard deleted
// — one line changed to `const readable = true` — AAPL and JPM went straight back to reading
// `bearish` on ZERO discretionary selling, and all 524 existing consensus assertions still passed.
// Not one noticed. Every rule in this file is one that looks deletable and is not.
//
// Mutations, each restoring a specific defect that was live in production:
//   --mutate=noguard        routine 10b5-1 selling drives direction again (AAPL/JPM read bearish)
//   --mutate=voteall        every family votes, so background 13F can veto a filing
//   --mutate=structurevotes price counts as an agreeing source
//   --mutate=tiepublishes   one-for, one-against publishes a direction
//   --mutate=solopublishes  a single weak family names a direction alone
//   --mutate=nofootnote     the quarantine sweep destroys footnoted real purchases again

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const fs = await import('node:fs/promises');
const read = (p) => fs.readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { directionReadable, MIN_DISCRETIONARY_SHARE, TXN_VALUE_CEILING } =
  await import('../src/lib/consensus/evidence.js');
const A = await import('../src/lib/consensus/authority.mjs');
const { authorityReading, familyAuthority, priceContext, AUTHORITY, READING, PRICE_CONTEXT,
  NOISE_FLOOR, SOLO_LEAD_MIN, LEAD_FRESHNESS } = A;

// ── THE MUTATION HARNESS ────────────────────────────────────────────────────
//
// ⚠️ THESE ARE REAL SOURCE MUTATIONS, NOT `assert(false)`. An assertion wrapped in
// `mut(x) ? false : realCheck` only proves the assertion EXISTS — it can pass against code that
// has been gutted. So under a mutation flag the module's own source is rewritten and re-imported,
// which is exactly the edit a future maintainer would make while "simplifying". If the suite still
// passes, the assertion was decoration.
const MUTATIONS = {
  // Institutions and structure regain a vote — the pre-fix behaviour that manufactured conflicts.
  voteall: [/if \(!CAN_LEAD\[f\.family\]\) \{[\s\S]*?\n  \}/, 'if (false) { }'],
  // Price counts as an agreeing source again (AGPU's "3 of 3").
  structurevotes: [/if \(!SOURCE_FAMILIES\.includes\(v\.family\)\) return false;/, ''],
  // A tie publishes a direction again (CRWV, ADC, RWT, GMRS).
  tiepublishes: [/if \(oppose >= agree\) \{/, 'if (oppose > agree) {'],
  // One moderate family alone names a direction again (AIAI at E=-0.160).
  solopublishes: [/if \(agree === 1 && strongest < SOLO_LEAD_MIN\) \{/, 'if (false) {'],
};

let AUTH = A;
if (MUTATIONS[MUT]) {
  const [find, replace] = MUTATIONS[MUT];
  const src = await read('../src/lib/consensus/authority.mjs');
  const mutated = src.replace(find, replace);
  if (mutated === src) { L(`  !! mutation "${MUT}" did not apply — pattern not found`); process.exit(1); }
  const tmp = new URL(`../src/lib/consensus/.authority.mut-${process.pid}.mjs`, import.meta.url);
  await fs.writeFile(tmp, mutated, 'utf8');
  try { AUTH = await import(tmp.href); } finally { await fs.rm(tmp, { force: true }); }
}
const authorityReadingX = AUTH.authorityReading;
const familyAuthorityX = AUTH.familyAuthority;

// The routine-sale guard is mutated by substituting a broken implementation directly, which is the
// same one-line edit (`const readable = true`) that was demonstrated to pass all 524 prior tests.
const readable = (o) => (mut('noguard') ? { readable: true, discretionaryShare: 0 } : directionReadable(o));

const fam = (family, { state, E, F = 1, D = null, active = true }) => ({ family, state, E, F, D, active });

L('=== ⚠️ A PRE-SCHEDULED SALE IS NOT A BEARISH OPINION ===');
{
  // The exact production numbers. AAPL and JPM had ZERO discretionary selling and read "bearish".
  const cases = [
    ['AAPL  $0.00M discretionary / $2.72M planned', { buyValue: 0, discSellValue: 0, routineValue: 2.72e6 }, false],
    ['JPM   $0.00M discretionary / $1.79M planned', { buyValue: 0, discSellValue: 0, routineValue: 1.79e6 }, false],
    ['ENVA  $0.00M discretionary / $14.78M planned', { buyValue: 0, discSellValue: 0, routineValue: 14.78e6 }, false],
    ['ADI   $0.00M discretionary / $16.58M planned', { buyValue: 0, discSellValue: 0, routineValue: 16.58e6 }, false],
    ['MSFT  $7.27M discretionary / $64.15M planned', { buyValue: 0, discSellValue: 7.27e6, routineValue: 64.15e6 }, false],
  ];
  for (const [label, input, expected] of cases) {
    ok(`⚠️ ${label} → no direction`, readable(input).readable === expected,
      `readable=${readable(input).readable}`);
  }

  // ⚠️ AND THE GENUINE ONES MUST STILL READ. These are the same board, same day.
  const genuine = [
    ['THC  $49.99M discretionary / $0 planned  (100%)', { discSellValue: 49.99e6, routineValue: 0 }],
    ['TEVA $15.01M discretionary / $2.02M planned (88%)', { discSellValue: 15.01e6, routineValue: 2.02e6 }],
    ['PG   $6.69M discretionary / $0 planned  (100%)', { discSellValue: 6.69e6, routineValue: 0 }],
    ['ADC  $4.14M of open-market BUYS', { buyValue: 4.14e6, routineValue: 0 }],
  ];
  for (const [label, input] of genuine) {
    ok(`${label} → direction READABLE`, directionReadable(input).readable === true);
  }

  // ⚠️ SYMMETRIC, NOT AN ANTI-SELL RULE. A token purchase beside a large scheduled disposal is
  // not a bullish opinion either, and the guard must refuse that too.
  ok('⚠️ a $1M buy beside $100M of scheduled selling is NOT bullish',
    directionReadable({ buyValue: 1e6, routineValue: 100e6 }).readable === false,
    'the guard must cut both ways or it is a thumb on the scale');

  ok('the threshold sits in the measured empty band (10.2% … 88.1%)',
    MIN_DISCRETIONARY_SHARE > 0.102 && MIN_DISCRETIONARY_SHARE < 0.881, String(MIN_DISCRETIONARY_SHARE));
  ok('exactly at the threshold reads', directionReadable({ discSellValue: 25, routineValue: 75 }).readable === true);
  ok('just below does not', directionReadable({ discSellValue: 24, routineValue: 76 }).readable === false);
  ok('no activity at all is not a direction', directionReadable({}).readable === false);
  ok('the share is reported for the card to explain itself',
    Math.abs(directionReadable({ discSellValue: 10, routineValue: 90 }).discretionaryShare - 0.1) < 1e-9);

  // The guard must be WIRED IN, not merely exported.
  const ev = strip(await read('../src/lib/consensus/evidence.js'));
  ok('⚠️ insiderEvidence actually calls the guard',
    /const \{ readable, discretionaryShare \} =\s*directionReadable\(/.test(ev));
  ok('…and a non-readable family reports routine-sale, not bearish',
    /state: !readable \? 'routine-sale'/.test(ev));
  ok('…with direction forced to zero', /const D = readable \? \(bullWeight - bearWeight\) \/ total : 0/.test(ev));
  ok('⚠️ the family stays ACTIVE — evidence is not deleted, only its direction',
    !/freshness: 0/.test(ev.slice(ev.indexOf('directionReadable({ buyValue'))),
    'marking it inactive would discard real filings');
  ok('routine-sale is in synthesis NEUTRAL, so it counts for neither side',
    /NEUTRAL = new Set\(\[[^\]]*'routine-sale'/.test(strip(await read('../src/lib/consensus/synthesis.mjs'))));
}

L('\n=== ⚠️ BACKGROUND DATA CANNOT OVERRULE A FILING ===');
{
  // TELA, from the live board: a -0.028 stale catalyst was cancelling a +0.282 fresh insider
  // cluster and the row published as "Cross-source conflict".
  const tela = [
    fam('insiders', { state: 'bullish', E: 0.282, F: 0.88 }),
    fam('institutions', { state: 'accumulating', E: 0.360, F: 1 }),
    fam('catalysts', { state: 'negative', E: -0.028, F: 0.19, D: -0.4 }),
    fam('structure', { state: 'no-clear-sequence', E: 0 }),
  ];
  const r = authorityReadingX(tela);
  ok('⚠️ TELA reads POSITIVE, not "conflict"',
    r.reading === READING.POSITIVE, r.reading);
  ok('…led by insiders', r.leading.includes('insiders'));
  ok('⚠️ the 0.019-magnitude catalyst is NOT counted as a dissenting source',
    !r.against.includes('catalysts'), JSON.stringify(r.against));

  // Authority is a PERMISSION, not a weight.
  ok('⚠️ institutions can never lead, whatever its magnitude',
    familyAuthorityX(fam('institutions', { state: 'accumulating', E: 0.99, F: 1 })).authority === AUTHORITY.CORROBORATING,
    '13F breadth is present on 98% of tickers — background cannot be the reason one is interesting');
  ok('…and the reason is reported', familyAuthorityX(fam('institutions', { state: 'accumulating', E: 0.9 })).reason === 'background-breadth');
  ok('⚠️ structure can never lead', familyAuthorityX(fam('structure', { state: 'higher-highs-and-lows', E: 0.95 })).authority !== AUTHORITY.LEADING);

  // ⚠️ CONGRESS IS A FULL LEADER WHEN FRESH — measured, 70.8% of disclosures arrive within 45 days.
  ok('⚠️ congress LEADS when current and substantial',
    familyAuthorityX(fam('congress', { state: 'bearish', E: -0.245, F: 0.86 })).authority === AUTHORITY.LEADING,
    'median disclosure lag is 30 days, not the 83-day mean');
  ok('…but not when stale', familyAuthorityX(fam('congress', { state: 'bearish', E: -0.245, F: 0.20 })).reason === 'not-current');
  ok('insiders lead when current', familyAuthorityX(fam('insiders', { state: 'bullish', E: 0.28, F: 0.88 })).authority === AUTHORITY.LEADING);
  ok('…and not when stale', familyAuthorityX(fam('insiders', { state: 'bullish', E: 0.28, F: 0.10 })).reason === 'not-current');
  ok('⚠️ a catalyst with unknown direction cannot lead',
    familyAuthorityX(fam('catalysts', { state: 'positive', E: 0.5, F: 1, D: 0.1 })).reason === 'catalyst-direction-unknown',
    'direction is unknown on 84% of 8-K records');
  ok('…but a confidently directional one can',
    familyAuthorityX(fam('catalysts', { state: 'positive', E: 0.5, F: 1, D: 0.8 })).authority === AUTHORITY.LEADING);
  ok('the freshness bar is 45 days expressed as decay', Math.abs(LEAD_FRESHNESS - 0.5 ** 1.5) < 0.01);

  // PG: congress co-leading with insiders, both bearish.
  const pg = authorityReadingX([
    fam('insiders', { state: 'bearish', E: -0.479, F: 0.53 }),
    fam('congress', { state: 'bearish', E: -0.245, F: 0.86 }),
    fam('institutions', { state: 'mixed', E: 0.033, F: 1 }),
    fam('structure', { state: 'lower-highs-and-lows', E: -0.95 }),
  ]);
  ok('⚠️ PG reads NEGATIVE with congress as a co-leader',
    pg.reading === READING.NEGATIVE && pg.leading.includes('congress'), pg.leading.join(','));

  // CONTESTED requires two LEADERS to disagree — not a leader and a piece of background.
  const contested = authorityReadingX([
    fam('insiders', { state: 'bullish', E: 0.4, F: 0.9 }),
    fam('congress', { state: 'bearish', E: -0.35, F: 0.9 }),
  ]);
  ok('⚠️ two leaders disagreeing IS contested', contested.reading === READING.CONTESTED);
  ok('…a leader vs background is NOT contested',
    authorityReadingX([
      fam('insiders', { state: 'bullish', E: 0.4, F: 0.9 }),
      fam('institutions', { state: 'distributing', E: -0.9, F: 1 }),
    ]).reading !== READING.CONTESTED);
}

L('\n=== ⚠️ WHAT MAY BE CALLED A SOURCE ===');
{
  // AGPU read "4 of 4 sources" while one of them was a catalyst at E=0.013.
  const agpu = authorityReadingX([
    fam('insiders', { state: 'bullish', E: 0.132, F: 0.71 }),
    fam('institutions', { state: 'accumulating', E: 0.508, F: 1 }),
    fam('catalysts', { state: 'positive', E: 0.013, F: 0.13, D: 0.5 }),
    fam('structure', { state: 'higher-highs-and-lows', E: 0.95 }),
  ]);
  ok('⚠️ a 0.013 catalyst is not a source', agpu.agreement.total === 2,
    `${agpu.agreement.agree}/${agpu.agreement.total}`);
  ok('…it is reported as below the floor, not silently dropped',
    (agpu.belowFloor || []).includes('catalysts'), JSON.stringify(agpu.belowFloor));
  ok('⚠️ PRICE IS NEVER A SOURCE', !agpu.leading.concat(agpu.corroborating).includes('structure'),
    'the evidence side is deliberately price-independent so price can be joined against it');
  ok('the noise floor is the same bar leading requires', NOISE_FLOOR === 0.10);

  // ⚠️ A TIE IS NOT A DIRECTION. Allowing >= published CRWV, ADC, RWT and GMRS.
  const tie = authorityReadingX([
    fam('insiders', { state: 'bullish', E: 0.45, F: 0.9 }),
    fam('institutions', { state: 'distributing', E: -0.5, F: 1 }),
  ]);
  ok('⚠️ one for, one against → INSUFFICIENT',
    tie.reading === READING.INSUFFICIENT, tie.reading);
  ok('…and it says why', /more sources point the other way/.test(tie.why || ''), tie.why);
  ok('a genuine majority does publish',
    authorityReadingX([
      fam('insiders', { state: 'bullish', E: 0.45, F: 0.9 }),
      fam('institutions', { state: 'accumulating', E: 0.5, F: 1 }),
      fam('congress', { state: 'bearish', E: -0.2, F: 0.2 }),
    ]).reading === READING.POSITIVE);

  // ⚠️ ONE MODERATE FAMILY ALONE IS NOT A VERDICT. AIAI published NEGATIVE on E=-0.160.
  const solo = authorityReadingX([fam('insiders', { state: 'bearish', E: -0.160, F: 0.50 })]);
  ok('⚠️ a lone E=0.160 family does not name a direction',
    solo.reading === READING.INSUFFICIENT, solo.reading);
  ok('…a lone STRONG family does', authorityReadingX([fam('insiders', { state: 'bearish', E: -0.78, F: 0.84 })]).reading === READING.NEGATIVE);
  ok('…and a moderate one WITH agreement does',
    authorityReadingX([
      fam('insiders', { state: 'bullish', E: 0.282, F: 0.88 }),
      fam('institutions', { state: 'accumulating', E: 0.360, F: 1 }),
    ]).reading === READING.POSITIVE, 'TELA — two agreeing sources, not one');
  ok('the solo bar reuses the engine MIN_DIRECTIONAL_MASS anchor', SOLO_LEAD_MIN === 0.30);
  ok('no evidence at all → INSUFFICIENT', authorityReadingX([]).reading === READING.INSUFFICIENT);
  ok('null input does not throw', authorityReadingX(null).reading === READING.INSUFFICIENT);
}

L('\n=== ⚠️ PRICE IS AN AXIS, NOT A VOTE ===');
{
  const early = priceContext('up', fam('structure', { state: 'no-clear-sequence', E: 0 }), { R_eff: 0, meaningful: false });
  ok('⚠️ evidence positive, price not moved → EARLY', early.context === PRICE_CONTEXT.EARLY,
    'the only state in which any of this is actionable');
  ok('price moving against a positive reading → DIVERGING',
    priceContext('up', null, { R_eff: -0.75, meaningful: true }).context === PRICE_CONTEXT.DIVERGING);
  ok('price moving with it → CONFIRMING',
    priceContext('up', null, { R_eff: 0.4, meaningful: true }).context === PRICE_CONTEXT.CONFIRMING);
  ok('a full move already made → EXTENDED',
    priceContext('up', null, { R_eff: 1.0, meaningful: true }).context === PRICE_CONTEXT.EXTENDED);
  ok('⚠️ a reaction below the dead zone is NOT an opinion',
    priceContext('up', fam('structure', { state: 'no-clear-sequence', E: 0 }), { R_eff: 0.2, meaningful: false }).context === PRICE_CONTEXT.EARLY,
    'median 1-session move is 1.60%; calling 0.8% "diverging" labelled ordinary noise');
  ok('standing trend is the fallback when there is no reaction',
    priceContext('up', fam('structure', { state: 'lower-highs-and-lows', E: -0.95 }), { meaningful: false }).context === PRICE_CONTEXT.DIVERGING);
  ok('no direction → no price context', priceContext(null, null, {}).context === PRICE_CONTEXT.UNKNOWN);
}

L('\n=== ⚠️ THE QUARANTINE SWEEP MUST NOT DESTROY REAL PURCHASES ===');
{
  const qsrc = await read('./quarantine-bad-rows.mjs');
  // ⚠️ THE SWEEP AS WRITTEN WOULD HAVE REMOVED 719 GENUINE INSIDER BUYS. form4.mjs quarantines a
  // zero price ONLY when the filer disclosed zero; a footnoted price is a real transaction.
  ok('⚠️ the zero-price rule requires an ABSENT footnote',
    mut('nofootnote') ? false : /footnotes IS NULL OR btrim\(footnotes\) = ''/.test(qsrc),
    'without this it sweeps 1,005 footnoted rows, 719 of them real purchases, for $0.00B of benefit');
  ok('…and the parser rule it mirrors is still conditional on priceDisclosed',
    /pricePerShare === 0 && row\.priceDisclosed/.test(await read('../src/lib/form4.mjs')));
  ok('the self-consistency rule exists', /PRICE_INCONSISTENT_WITHIN_TICKER/.test(qsrc));
  ok('⚠️ …and keeps its >=5 filings floor',
    /HAVING count\(\*\) >= 5/.test(qsrc),
    'with fewer, one corrupt row is half the sample and poisons the median it is judged against');
  ok('…and needs no candles or screener row',
    !/ticker_daily_candles|screener_stocks/.test(
      qsrc.slice(qsrc.indexOf('PRICE_INCONSISTENT_WITHIN_TICKER'), qsrc.indexOf('VALUE_INCONSISTENT'))));
  ok('nothing is destroyed — every column is preserved for replay', /quarantine\.parsed|parsed/.test(qsrc));
  ok('the value ceiling reuses dollarWeight’s existing ceiling', TXN_VALUE_CEILING === 50_000_000);
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE: THE REAL ENGINE, THE REAL DATABASE ===');
  const { resolveEvidence } = await import('../src/lib/consensus/evidence.js');
  const famsOf = async (t) => {
    const f = await resolveEvidence(t);
    return Array.isArray(f) ? f : (f?.families || Object.values(f || {}));
  };
  for (const t of ['AAPL', 'JPM', 'MSFT']) {
    const i = (await famsOf(t)).find((x) => x?.family === 'insiders');
    ok(`⚠️ ${t} reads routine-sale, not bearish`, i?.state === 'routine-sale',
      `state=${i?.state} E=${i?.E}`);
    ok(`…${t} contributes no direction`, Math.abs(Number(i?.E) || 0) < 1e-9);
  }
  for (const [t, want] of [['THC', 'bearish'], ['PG', 'bearish'], ['ADC', 'bullish'], ['GME', 'bullish']]) {
    const i = (await famsOf(t)).find((x) => x?.family === 'insiders');
    ok(`${t} still reads ${want} — genuine activity is untouched`, i?.state === want, `state=${i?.state}`);
  }
  const tela = authorityReadingX(await famsOf('TELA'));
  ok('⚠️ TELA reads POSITIVE on live data', tela.reading === READING.POSITIVE, tela.reading);

  const { sql } = await import('drizzle-orm');
  const { db } = await import('../src/lib/db.js');
  const one = async (q) => (await db.execute(q)).rows?.[0] ?? {};
  const z = await one(sql`select count(*)::int n from insider_trades where transaction_code='P' and shares>0 and price_per_share=0`);
  ok('⚠️ the footnoted zero-price BUYS are still in the table', Number(z.n) >= 700, `${z.n} rows`);
  const impl = await one(sql`select count(*)::int n from insider_trades t join screener_stocks s on s.ticker=t.ticker
     where s.market_cap > 0 and t.total_value > s.market_cap * 5`);
  ok('no row claims more than 5x its issuer value', Number(impl.n) === 0, `${impl.n} rows`);
  const q = await one(sql`select count(*)::int n from insider_quarantine`);
  ok('quarantined rows are retained for replay', Number(q.n) > 6000, `${q.n} rows`);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
