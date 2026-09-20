// VERIFY THE "CONFIRMED SWING STRUCTURE" WORDING.
//
// The engine identifies a higher-high/higher-low SEQUENCE that has already formed. Measured over
// 112,620 point-in-time samples, that reading is accurate about the trailing window (78.6% matching
// sign) and a coin flip across the span it is displayed (46.7%). "Uptrend" claimed the latter.
//
// This suite exists so the stronger wording cannot quietly return. It asserts the card's user-facing
// states, and --mutate proves each assertion fails when the old wording is reinstated.
//
// It deliberately does NOT assert anything about the classifier: same states, same field, same
// colours. Only the claim changed.
//
// Run: node scripts/verify-swing-structure-wording.mjs [--mutate]

import fs from 'node:fs';

const L = (s = '') => console.log(s);
const MUT = process.argv.includes('--mutate');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const PATH = 'src/components/MarketStructure.jsx';
let src = fs.readFileSync(PATH, 'utf8');
if (MUT) {
  // Reinstate exactly the defect: present-tense trend claims.
  src = src.replace(/uptrend: '[^']*'/, "uptrend: 'Uptrend'")
    .replace(/downtrend: '[^']*'/, "downtrend: 'Downtrend'")
    .replace(/range: '[^']*'/, "range: 'Range'");
}

// The label map, extracted rather than eval'd.
const block = src.slice(src.indexOf('const TREND_LABEL'), src.indexOf('const trendColor'));
// Keys may be bare (uptrend) or quoted ('insufficient-history'), so both forms are accepted.
const labelOf = (k) => (block.match(new RegExp(`'?${k}'?:\\s*'([^']*)'`)) || [])[1];

L('=== the card describes confirmed structure ===');
ok('the up state names the sequence, not a trend', labelOf('uptrend') === 'Higher highs & lows', labelOf('uptrend'));
ok('the down state names the sequence, not a trend', labelOf('downtrend') === 'Lower highs & lows', labelOf('downtrend'));
ok('the neutral state says no clear sequence', labelOf('range') === 'No clear sequence', labelOf('range'));

L('\n=== the overstated wording is gone ===');
for (const word of ['Uptrend', 'Downtrend']) {
  ok(`the card no longer renders "${word}" as a state`, !new RegExp(`:\\s*'${word}'`).test(block), word);
}

L('\n=== the anchoring line says what the date means ===');
ok('the pivot line reads "confirmed on", not "anchored on"',
  src.includes('this structure was confirmed on') && !src.includes('this label is anchored on'));

L('\n=== the classifier is untouched ===');
// The states and the colour mapping are behaviour, not copy, and must not have moved.
ok('the three engine states are still the keys', ['uptrend', 'downtrend', 'range'].every((k) => labelOf(k) != null));
ok('insufficient-history is still handled', labelOf('insufficient-history') === 'Insufficient history');
ok('the colour mapping still keys off the raw engine values',
  /t === 'uptrend' \? C\.green : t === 'downtrend' \? C\.red/.test(src));
ok('the card still reads the engine field tf.trend', src.includes('TREND_LABEL[tf.trend]'));

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
