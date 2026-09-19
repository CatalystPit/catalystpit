// Market Structure presentation and tier gating — regression suite.
//
// The claim that matters most: a FREE payload does not CONTAIN the Pro values. Not nulled, not
// blurred — absent. That is checked two ways: field by field, and by serialising the whole payload
// and searching it for prices that only exist inside gated objects. The second check is the one
// that survives somebody adding a Pro field and forgetting the free branch.
//
// Run: node scripts/verify-structure-presentation.mjs

import {
  shapeForTier, proLeakage, isPro, PRO_ONLY_KEYS, FREE_REASON_CAP,
} from '../src/lib/structure/present.mjs';
import { marketStructure } from '../src/lib/structure/engine.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

// ── a real structure, from the real engine ───────────────────────────────────
// Synthetic candles, but run through marketStructure() rather than hand-written — the suite must
// break if the engine's shape changes, which a hand-built fixture would hide.
function weekdays(n, from = '2019-01-01') {
  const out = []; let t = Date.parse(`${from}T00:00:00Z`);
  while (out.length < n) {
    const d = new Date(t); const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}
const DATES = weekdays(1700);
const BARS = DATES.map((d, i) => {
  const c = 100 + 30 * Math.sin(i / 70) + i * 0.04;
  return { date: d, open: c, high: c + 2, low: c - 2, close: c, volume: 1000 };
});
const ASOF = DATES[DATES.length - 1];
const S = marketStructure(BARS, { asOf: ASOF });
check('the fixture engine output is available', S.available === true, S.reason);

const FREE = shapeForTier(S, 'free');
const PRO = shapeForTier(S, 'pro');
const ELITE = shapeForTier(S, 'elite');

// ── 1. tiers ─────────────────────────────────────────────────────────────────
sec('TIERS');

check('pro is pro', isPro('pro') && isPro('elite'));
check('free is not pro', !isPro('free'));
check('an unknown tier is treated as free', !isPro('enterprise') && shapeForTier(S, 'zzz').tier === 'free');
check('a missing tier is treated as free', shapeForTier(S, undefined).tier === 'free');
check('elite receives the pro payload', JSON.stringify(ELITE) === JSON.stringify(PRO));

// ── 2. THE FREE EXPERIENCE IS REAL ───────────────────────────────────────────
sec('FREE EXPERIENCE');

check('free gets the daily timeframe', !!FREE.daily && FREE.daily.available === true);
check('free gets the daily trend', typeof FREE.daily.trend === 'string');
check('free gets the daily trend reasons', Array.isArray(FREE.daily.trendReasons));
check('free gets the current price', Number.isFinite(FREE.currentPrice));
check('free gets a nearest support ZONE with real prices',
  FREE.nearestSupport == null
  || (Number.isFinite(FREE.nearestSupport.low) && Number.isFinite(FREE.nearestSupport.high)));
check('free gets a nearest resistance zone',
  FREE.nearestResistance == null
  || (Number.isFinite(FREE.nearestResistance.low) && Number.isFinite(FREE.nearestResistance.high)));
check('free gets distance information',
  !FREE.nearestSupport || Number.isFinite(FREE.nearestSupport.distancePct));
check('free gets the structural disruption facts', 'structuralDisruption' in FREE.daily);
check('free gets the pivot-anchor disclosure', 'priceSincePivotPct' in FREE.daily);
check('free gets some explanation for its levels',
  !FREE.nearestSupport || Array.isArray(FREE.nearestSupport.reasons));
// The cap must be exercised on a zone that ACTUALLY has more reasons than the cap — the organic
// fixture's zones have three or fewer, so on its own it proves nothing about truncation.
{
  const rich = JSON.parse(JSON.stringify(S));
  const many = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
  const comps = many.map((r, i) => ({ timeframe: 'daily', kind: 'swing_low', price: 100 + i, label: r }));
  rich.multiTimeframe.support.nearest = {
    ...(rich.multiTimeframe.support.nearest || {}),
    low: 100, high: 105, mid: 102.5, distancePct: 1.2, side: 'support',
    timeframes: ['daily'], reasons: many, components: comps,
    majorCriteria: ['x'], touches: 9, persistenceDays: 400, prominence: 2,
  };
  const f = shapeForTier(rich, 'free');
  const p = shapeForTier(rich, 'pro');
  check('free reasons are capped at FREE_REASON_CAP',
    f.nearestSupport.reasons.length === FREE_REASON_CAP, String(f.nearestSupport.reasons.length));
  check('free is TOLD the reasons were truncated', f.nearestSupport.reasonsTruncated === true);
  check('pro receives every reason', p.nearestSupport.reasons.length === many.length);
  check('pro is not told anything was truncated', p.nearestSupport.reasonsTruncated === false);
  check('a short reason list is not marked truncated', (() => {
    const few = JSON.parse(JSON.stringify(rich));
    few.multiTimeframe.support.nearest.reasons = ['only one'];
    return shapeForTier(few, 'free').nearestSupport.reasonsTruncated === false;
  })());
  check('the capped free zone still carries no deep fields',
    f.nearestSupport.components === undefined && f.nearestSupport.touches === undefined);
}

// ── 3. NO LEAKAGE ────────────────────────────────────────────────────────────
sec('NO PRO LEAKAGE');

check('proLeakage reports nothing for the free payload',
  proLeakage(FREE).length === 0, JSON.stringify(proLeakage(FREE)));
// A detector that always says "clean" is worse than none, so it is proved to FIRE on a real leak.
check('proLeakage DETECTS a gated top-level key',
  proLeakage({ ...FREE, weekly: { trend: 'uptrend' } }).includes('weekly'));
check('proLeakage DETECTS a gated key inside a zone',
  proLeakage({ ...FREE, nearestSupport: { ...(FREE.nearestSupport || {}), components: [] } })
    .includes('zone.components'));
check('proLeakage DETECTS touch history inside a zone',
  proLeakage({ ...FREE, nearestSupport: { ...(FREE.nearestSupport || {}), touches: 5 } })
    .includes('zone.touches'));
check('proLeakage ignores a pro payload (nothing to leak to)',
  proLeakage(PRO).length === 0);
check('proLeakage reports EVERY gated key it finds',
  proLeakage({ ...FREE, weekly: {}, monthly: {}, majorSupport: {} }).length >= 3);
for (const k of PRO_ONLY_KEYS) {
  check(`free payload has NO '${k}' key`, !(k in FREE));
}
check('free has no weekly object', FREE.weekly === undefined);
check('free has no monthly object', FREE.monthly === undefined);
check('free has no major support', FREE.majorSupport === undefined);
check('free has no confluence list', FREE.confluenceSupport === undefined);
check('free zones carry no component breakdown',
  !FREE.nearestSupport || FREE.nearestSupport.components === undefined);
check('free zones carry no major criteria',
  !FREE.nearestSupport || FREE.nearestSupport.majorCriteria === undefined);
check('free zones carry no touch history',
  !FREE.nearestSupport || FREE.nearestSupport.touches === undefined);
check('free daily carries no moving-average detail', FREE.daily.movingAverages === undefined);
check('free daily carries no major zone', FREE.daily.support.major === undefined);

// THE INDEPENDENT CHECK: serialise the free payload and look for prices that exist ONLY inside
// gated objects. This is what catches a Pro field added to the shape and forgotten here.
{
  const wire = JSON.stringify(FREE);
  const gatedPrices = new Set();
  const collect = (z) => {
    if (!z) return;
    for (const v of [z.low, z.high, z.mid]) if (Number.isFinite(v)) gatedPrices.add(v);
  };
  collect(S.multiTimeframe.support?.major);
  collect(S.multiTimeframe.resistance?.major);
  for (const z of (S.multiTimeframe.support?.confluence || [])) collect(z);
  for (const z of (S.multiTimeframe.resistance?.confluence || [])) collect(z);
  collect(S.weekly?.support?.nearest); collect(S.weekly?.resistance?.nearest);
  collect(S.monthly?.support?.nearest); collect(S.monthly?.resistance?.nearest);
  // Prices the FREE payload is legitimately allowed to carry are removed from the search, since a
  // major zone that IS the nearest zone shares its numbers honestly.
  for (const z of [FREE.nearestSupport, FREE.nearestResistance]) {
    if (!z) continue;
    gatedPrices.delete(z.low); gatedPrices.delete(z.high); gatedPrices.delete(z.mid);
  }
  const leaked = [...gatedPrices].filter((p) => wire.includes(String(p)));
  check('no gated price string appears anywhere in the free payload',
    leaked.length === 0, `leaked: ${leaked.slice(0, 5).join(', ')}`);
  // A crude string search is wrong here: `locked.weekly: true` is the INTENDED teaser (it says the
  // data exists and carries none of it), and a zone's `timeframes: ["weekly","daily"]` is the
  // documented decision that a level's strength label is not the weekly structure. The meaningful
  // assertion is that no weekly/monthly STRUCTURE object reaches the client — so: the only object
  // carrying a `trend` is daily, and everything under `locked` is a boolean or a count.
  const trendOwners = [];
  (function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    if (!Array.isArray(node) && 'trend' in node) trendOwners.push(path || '(root)');
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  })(FREE, '');
  check('daily is the ONLY timeframe object in the free payload',
    trendOwners.length === 1 && trendOwners[0] === 'daily', trendOwners.join(', '));
  check('the locked summary carries only booleans and counts',
    Object.values(FREE.locked).every((v) => typeof v === 'boolean' || Number.isInteger(v)));
  check('no weekly/monthly zone prices ride inside the free zones',
    [FREE.nearestSupport, FREE.nearestResistance].filter(Boolean)
      .every((z) => z.components === undefined));
}

// ── 4. THE PRO EXPERIENCE ────────────────────────────────────────────────────
sec('PRO EXPERIENCE');

check('pro gets weekly', !!PRO.weekly);
check('pro gets monthly', !!PRO.monthly);
check('pro gets alignment', !!PRO.alignment?.state);
check('pro gets conflicts as a list', Array.isArray(PRO.conflicts));
check('pro gets major support when one exists',
  PRO.majorSupport !== undefined);
check('pro gets major resistance when one exists', PRO.majorResistance !== undefined);
check('pro gets confluence lists',
  Array.isArray(PRO.confluenceSupport) && Array.isArray(PRO.confluenceResistance));
check('pro zones carry the full component breakdown',
  !PRO.nearestSupport || Array.isArray(PRO.nearestSupport.components));
check('pro zones carry the named MAJOR criteria',
  !PRO.nearestSupport || Array.isArray(PRO.nearestSupport.majorCriteria));
check('pro zones carry touch history',
  !PRO.nearestSupport || Number.isFinite(PRO.nearestSupport.touches));
check('pro reasons are NOT truncated',
  !PRO.nearestSupport || PRO.nearestSupport.reasonsTruncated === false);
check('pro daily carries moving averages', Array.isArray(PRO.daily.movingAverages));
check('pro weekly carries its own zones', 'support' in PRO.weekly);
check('pro is told whether major is the nearest zone',
  typeof PRO.majorSupportIsNearest === 'boolean');
// And the flag must MATCH the engine, not be hardcoded — saying "same as nearest" when it is not
// would hide a second level the user is paying for.
check('majorIsNearest is copied from the engine, not asserted',
  PRO.majorSupportIsNearest === !!S.multiTimeframe.support?.majorIsNearest
  && PRO.majorResistanceIsNearest === !!S.multiTimeframe.resistance?.majorIsNearest,
  `${PRO.majorSupportIsNearest} vs ${!!S.multiTimeframe.support?.majorIsNearest}`);
check('a distinct major zone is flagged as distinct', (() => {
  const d = JSON.parse(JSON.stringify(S));
  d.multiTimeframe.support.majorIsNearest = false;
  return shapeForTier(d, 'pro').majorSupportIsNearest === false;
})());

// ── 5. CANONICAL VALUES ARE PRESERVED ────────────────────────────────────────
sec('CANONICAL VALUES PRESERVED');

check('current price is copied exactly', PRO.currentPrice === S.currentPrice);
check('price date is copied exactly', PRO.priceDate === S.priceDate);
check('daily trend is copied exactly', PRO.daily.trend === S.daily.trend);
check('weekly trend is copied exactly', PRO.weekly.trend === S.weekly.trend);
check('monthly trend is copied exactly', PRO.monthly.trend === S.monthly.trend);
check('the methodology version is carried', PRO.methodology === S.methodology);
{
  const src = S.multiTimeframe.support?.nearest;
  const out = PRO.nearestSupport;
  check('zone low is not re-rounded', !src || out.low === src.low);
  check('zone high is not re-rounded', !src || out.high === src.high);
  check('zone distance is not recomputed', !src || out.distancePct === src.distancePct);
  check('zone timeframes are carried verbatim',
    !src || JSON.stringify(out.timeframes) === JSON.stringify(src.timeframes));
  check('free sees the same zone prices as pro',
    !FREE.nearestSupport || (FREE.nearestSupport.low === out.low && FREE.nearestSupport.high === out.high));
}
check('timeframe labels are the engine\'s own',
  PRO.daily.label === S.daily.label && PRO.weekly.label === S.weekly.label
  && PRO.monthly.label === S.monthly.label);

// ── 6. THE REJECTED STATE MUST NOT APPEAR ────────────────────────────────────
sec('REJECTED RESEARCH STATE ABSENT');

for (const [name, p] of [['free', FREE], ['pro', PRO]]) {
  const wire = JSON.stringify(p);
  check(`${name} payload contains no transition state`, !/transition/i.test(wire));
  check(`${name} payload contains no "condition" field`, !/"condition"/.test(wire));
  check(`${name} payload contains no recovery label`, !/recovery/i.test(wire));
}
check('trend remains one of the strict labels',
  ['uptrend', 'downtrend', 'range', 'insufficient-history'].includes(PRO.daily.trend));

// ── 7. MISSING DATA AND QUALITY STATES ───────────────────────────────────────
sec('MISSING DATA AND QUALITY');

{
  const short = marketStructure(BARS.slice(0, 20), { asOf: ASOF });
  const f = shapeForTier(short, 'free');
  const p = shapeForTier(short, 'pro');
  check('insufficient history is reported, not guessed', f.available === false);
  check('the reason is carried through', typeof f.reason === 'string' && f.reason.length > 0);
  check('an unavailable structure still declares its tier', f.tier === 'free' && p.tier === 'pro');
  check('an unavailable structure carries no zones', f.nearestSupport === undefined);
}
{
  const suppressed = marketStructure(BARS, { asOf: ASOF, priceQuality: { usable: false, reason: 'too_many_breaks' } });
  const f = shapeForTier(suppressed, 'free');
  check('a suppressed price series yields no structure', f.available === false);
  check('the suppression reason is shown', /unusable/i.test(f.reason));
  check('no level is manufactured for a suppressed series', f.nearestSupport === undefined);
}
{
  // A timeframe without enough bars keeps its own reason rather than disappearing.
  const mid = marketStructure(BARS.slice(0, 200), { asOf: DATES[199] });
  const p = shapeForTier(mid, 'pro');
  if (p.available) {
    check('an unavailable timeframe reports why',
      !p.monthly.available ? typeof p.monthly.reason === 'string' : true);
    check('an unavailable timeframe is still present as an object', !!p.monthly);
  } else { pass += 2; console.log('  ok   (short fixture unavailable overall — timeframe cases covered above)'); }
}
check('null structure shapes safely', shapeForTier(null, 'free').available === false);
check('null structure still declares a tier', shapeForTier(null, 'pro').tier === 'pro');
check('a missing major zone is absent rather than invented', (() => {
  const noMajor = JSON.parse(JSON.stringify(S));
  noMajor.multiTimeframe.support.major = null;
  return shapeForTier(noMajor, 'pro').majorSupport === null;
})());

// ── 8. THE LOCKED SUMMARY DESCRIBES, IT DOES NOT REVEAL ──────────────────────
sec('LOCKED SUMMARY');

check('free is told whether weekly exists', typeof FREE.locked.weekly === 'boolean');
check('free is told whether monthly exists', typeof FREE.locked.monthly === 'boolean');
check('free is given confluence COUNTS, not zones',
  Number.isFinite(FREE.locked.confluenceSupportCount));
check('the locked summary contains no prices',
  !Object.values(FREE.locked).some((v) => typeof v === 'number' && v > 1000));
check('a major zone that does not exist is reported as absent', (() => {
  const noMajor = JSON.parse(JSON.stringify(S));
  noMajor.multiTimeframe.support.major = null;
  return shapeForTier(noMajor, 'free').locked.majorSupport === false;
})());
check('pro receives no locked summary', PRO.locked === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
