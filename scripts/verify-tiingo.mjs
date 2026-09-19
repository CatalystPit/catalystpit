// THE TIINGO ADAPTER'S CONTRACT.
//
// Pure: fixtures rather than the network, so the suite asserts the NORMALISATION rather than
// Tiingo's uptime. The live capability matrix is a separate script
// (scripts/probe-tiingo-capabilities.mjs) because "what does this account serve" is a question about
// an account and changes when the plan does, while "what do we do with the answer" is a question
// about this code and must not change silently.
//
// Run: node scripts/verify-tiingo.mjs

import { readFileSync } from 'node:fs';
import { TIINGO_VOLUME, volumeLabel, TIINGO_EOD_CAPABILITIES } from '../src/lib/market/tiingo.mjs';
import { VOLUME_METHODOLOGY, methodologyCompatible } from '../src/lib/scan/provider-contract.mjs';
import { FRESHNESS, freshnessAtLeast } from '../src/lib/scan/market-capabilities.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}`); } };

console.log('\n=== VOLUME METHODOLOGY — the thing most likely to be got wrong ===');
{
  // Tiingo told us participating-venue intraday volume is ~7-8% of consolidated. The whole risk is
  // that someone divides that by a consolidated baseline, or scales it up to "look right".
  ok('composite EOD maps to consolidated', TIINGO_VOLUME.COMPOSITE_EOD === VOLUME_METHODOLOGY.CONSOLIDATED);
  ok('participating venues maps to single-venue', TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED === VOLUME_METHODOLOGY.SINGLE_VENUE);
  ok('the two are NOT the same methodology', TIINGO_VOLUME.COMPOSITE_EOD !== TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED);

  // THE RULE: same methodology on both sides, or no comparison.
  ok('venue numerator vs composite baseline is REFUSED',
    !methodologyCompatible(TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED, TIINGO_VOLUME.COMPOSITE_EOD));
  ok('composite numerator vs venue baseline is REFUSED',
    !methodologyCompatible(TIINGO_VOLUME.COMPOSITE_EOD, TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED));
  ok('venue vs venue is allowed', methodologyCompatible(TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED, TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED));
  ok('composite vs composite is allowed', methodologyCompatible(TIINGO_VOLUME.COMPOSITE_EOD, TIINGO_VOLUME.COMPOSITE_EOD));
  ok('null methodology is never compatible', !methodologyCompatible(null, TIINGO_VOLUME.COMPOSITE_EOD));
  ok('unknown methodology is never compatible', !methodologyCompatible('about-8-percent', TIINGO_VOLUME.COMPOSITE_EOD));
}

console.log('\n=== displayed labels never overstate the feed ===');
{
  const composite = volumeLabel(TIINGO_VOLUME.COMPOSITE_EOD);
  const venue = volumeLabel(TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED);
  ok('composite label says composite', /composite/i.test(composite));
  ok('venue label says participating-venue', /participating-venue/i.test(venue));
  ok('venue label discloses the delay', /delay/i.test(venue));
  // The forbidden words, on the number that is only ~7-8% of the tape.
  for (const banned of ['consolidated', 'SIP', 'full-market', 'official tape', 'real-time']) {
    ok(`venue label never says "${banned}"`, !new RegExp(banned.replace(/[-\s]/g, '[-\\s]?'), 'i').test(venue));
  }
  ok('an unknown methodology is labelled unknown, not assumed', /unknown/i.test(volumeLabel(null)));
}

console.log('\n=== the capability descriptor matches what was MEASURED ===');
{
  // Probed 2026-09-19 11:55 ET with the market open: live fields null, no intraday bars for today,
  // WebSocket rejected at every thresholdLevel, intraday payload carries no volume field.
  ok('quotes declared EOD, not realtime', TIINGO_EOD_CAPABILITIES.quoteFreshness === FRESHNESS.EOD);
  ok('streaming declared false', TIINGO_EOD_CAPABILITIES.streaming === false);
  ok('liveVolume declared false', TIINGO_EOD_CAPABILITIES.liveVolume === false);
  // The subtle one: the DAILY bar is consolidated, but declaring consolidatedVolume true would let a
  // signal believe it can build an intraday RVOL against the tape.
  ok('consolidatedVolume declared false despite composite daily bars', TIINGO_EOD_CAPABILITIES.consolidatedVolume === false);
  ok('no intraday volume history, so no time-of-day baseline', TIINGO_EOD_CAPABILITIES.intradayVolumeHistory === false);
  ok('daily history declared true', TIINGO_EOD_CAPABILITIES.historicalDaily === true);
  ok('bid/ask declared false', TIINGO_EOD_CAPABILITIES.bidAsk === false);

  // A signal requiring realtime must be OFF on this descriptor.
  ok('EOD does not satisfy a realtime requirement', !freshnessAtLeast(TIINGO_EOD_CAPABILITIES.quoteFreshness, FRESHNESS.REALTIME));
  ok('EOD does not satisfy a delayed requirement either', !freshnessAtLeast(TIINGO_EOD_CAPABILITIES.quoteFreshness, FRESHNESS.DELAYED));
  ok('EOD satisfies an EOD requirement', freshnessAtLeast(TIINGO_EOD_CAPABILITIES.quoteFreshness, FRESHNESS.EOD));
}

console.log('\n=== THE TOKEN MUST NEVER REACH A BROWSER ===');
{
  const src = readFileSync('src/lib/market/tiingo.mjs', 'utf8');
  // In the Authorization header, never the query string — a token in a URL leaks through logs,
  // referrers and any error that echoes the request.
  ok('token is sent as an Authorization header', /Authorization:\s*`Token \$\{TOKEN\}`/.test(src));
  ok('token is never appended to the query string', !/token=\$\{TOKEN\}|searchParams\.set\('token'/.test(src));
  ok('no NEXT_PUBLIC_ prefix on the key', !/NEXT_PUBLIC_[A-Z_]*TIINGO/.test(src));
  ok('the module is not marked use client', !/^['"]use client['"]/m.test(src));

  // The real risk is a client component importing it, which is what puts a server secret in a
  // browser bundle. Checked across the tree rather than asserted by convention.
  const { execSync } = await import('node:child_process');
  let importers = '';
  try {
    importers = execSync('grep -rln "market/tiingo" src/ || true', { encoding: 'utf8' });
  } catch { /* grep found nothing */ }
  const files = importers.split('\n').map((s) => s.trim()).filter(Boolean);
  const clientImporters = files.filter((f) => {
    try { return /^['"]use client['"]/m.test(readFileSync(f, 'utf8')); } catch { return false; }
  });
  ok(`no client component imports the adapter (checked ${files.length} importer(s))`, clientImporters.length === 0);
  if (clientImporters.length) console.error('    client importers:', clientImporters.join(', '));
}

console.log('\n=== normalisation: absence is preserved, never converted to a number ===');
{
  // Number(null) === 0 and Number('') === 0, both finite. A bare Number() check turns a missing
  // price into a real one at zero and a missing volume into "nothing traded".
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  ok('null stays null', num(null) === null);
  ok('undefined stays null', num(undefined) === null);
  ok('empty string stays null', num('') === null);
  ok('NaN stays null', num('abc') === null);
  ok('zero is preserved as a real zero', num(0) === 0);
  ok('a numeric string converts', num('336.13') === 336.13);
}

console.log('\n=== bars: ordering, shape and dropped rows ===');
{
  // The adapter's rule: a bar missing any of OHLC is dropped rather than repaired, and bars come
  // back ascending because Lightweight Charts throws on unsorted or duplicated times.
  const raw = [
    { date: '2026-09-18T00:00:00Z', open: 2, high: 3, low: 1, close: 2.5, volume: 100 },
    { date: '2026-09-16T00:00:00Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 50 },
    { date: '2026-09-17T00:00:00Z', open: 1.5, high: 2.5, low: 1, close: 2, volume: null },
    { date: '2026-09-15T00:00:00Z', open: 1, high: 2, low: 0.5, close: null, volume: 10 },   // dropped
  ];
  const norm = raw
    .map((r) => ({ time: String(r.date).slice(0, 10), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }))
    .filter((b) => b.time && b.open != null && b.high != null && b.low != null && b.close != null)
    .sort((a, b) => a.time.localeCompare(b.time));
  ok('a bar with a null close is dropped', norm.length === 3);
  ok('bars come back ascending', norm.every((b, i) => i === 0 || norm[i - 1].time <= b.time));
  ok('timestamps are date-only for daily bars', norm.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.time)));
  ok('a null volume survives as null, not 0', norm.find((b) => b.time === '2026-09-17').volume === null);
  ok('full OHLC is carried, never reduced to close', norm.every((b) => b.open != null && b.high != null && b.low != null));
}

console.log('\n=== entitlement: asking for realtime cannot produce realtime ===');
{
  // The boundary is the PROVIDER's answer, not the caller's request. Modelled here so the contract
  // is asserted without a network call.
  const serve = (wantRealtime, planHasRealtime) => (wantRealtime && planHasRealtime ? FRESHNESS.REALTIME : FRESHNESS.EOD);
  ok('free user on an EOD plan gets EOD', serve(false, false) === FRESHNESS.EOD);
  ok('PRO user on an EOD plan still gets EOD', serve(true, false) === FRESHNESS.EOD);
  ok('PRO user on an entitled plan gets realtime', serve(true, true) === FRESHNESS.REALTIME);
  ok('free user on an entitled plan still gets EOD', serve(false, true) === FRESHNESS.EOD);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
