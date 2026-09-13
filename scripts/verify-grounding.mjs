// Proves src/lib/grounding.mjs is behaviourally identical to the validators that were defined
// inline in src/app/api/bulls-bears/route.js before extraction.
//
// The ORIGINAL implementations are recovered from git (commit d8dfe56, lines 227-340) and evaluated
// in isolation, so this compares the real pre-extraction code against the real post-extraction
// module — not a hand-copy of either. Every input is run through both and the results must match
// exactly (deep equality, including array order). Any mismatch exits non-zero.
//
// Run: node scripts/verify-grounding.mjs

import { execFileSync } from 'node:child_process';
import * as NEW from '../src/lib/grounding.mjs';

const ORIGINAL_REF = 'd8dfe56:src/app/api/bulls-bears/route.js';
const FROM_LINE = 227, TO_LINE = 340;

// ── recover the original block and evaluate it ───────────────────────────────
const original = execFileSync('git', ['show', ORIGINAL_REF], { encoding: 'utf8', maxBuffer: 32 << 20 })
  .replace(/\r\n/g, '\n').split('\n').slice(FROM_LINE - 1, TO_LINE).join('\n');

const OLD = await import(
  'data:text/javascript;base64,' + Buffer.from(
    original + '\nexport { valuesIn, claimNumbers, traced, nameClaims, nameTokens, validateBullet, '
             + 'GENERIC_CAPS, KNOWN_CATEGORIES, NAME_NOISE };\n', 'utf8').toString('base64'));

// ── corpus ───────────────────────────────────────────────────────────────────
const CORPUS = [
  '', ' ', null, undefined,
  'Revenue rose to $124.3B in fiscal 2024, up 12.4% year over year',
  'Apple Inc. reported EPS of 2.18 vs 1.97 expected, a 10.7% beat',
  'Director Arthur D. Levinson sold 24,000 shares at $187.42 for $4.5M',
  'FDA Approves First Therapy from Acme Pharmaceuticals, Inc.',
  'Short interest at 24.6:1 days to cover as of 2024-03-15',
  'The Federal Reserve held rates at 5.25%-5.50% since 1945',
  'Wall Street expects 3 analysts to cut targets on Big Tech',
  'Free cash flow of 1.2T against 850B of debt and 12 buybacks',
  'CFO Luca Maestri and CEO Tim Cook addressed the S&P 500 decline',
  'Net margin 37.36% vs 37.4% prior; ratio 2:1; 10 insiders sold',
  'Silicon Valley firm New York Times reported $0.01 per share',
  'Q3 2025 revenue $1,234,567.89 (+0.5%) with 5 directors voting',
  'no numbers or names here at all just plain lowercase words',
  'ALL CAPS HEADLINE WITH NO TRACEABLE CLAIMS 2026',
  'Tesla Motors Inc and Ford Motor Company announced 4.2M units',
  'Mixed: 12k units, 3.5b revenue, 900m cash, 45 employees, 7.2x multiple',
];

const HAYSTACKS = [
  '', 'Apple Inc reported revenue of 124300000000 and EPS 2.18 with margin 37.36',
  'LEVINSON ARTHUR D sold 24000 shares price 187.42 total 4500000',
  'Acme Pharmaceuticals Inc FDA approval therapy first',
  'Tesla Motors Inc Ford Motor Company units 4200000 revenue 3500000000 cash 900000000',
  'rates 5.25 5.50 federal reserve held since 1945 analysts 3',
];

const rnd = (() => { let s = 1234567; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const WORDS = ['Apple', 'Inc', 'revenue', 'the', 'Arthur', 'Levinson', 'Corp', '124.3B', '2.18', '37.4%',
  '12', '2024-01-01', '1945', '3:1', 'Wall', 'Street', 'Fed', 'sold', '24,000', '$187.42', 'k', 'm', 'b', 't'];
function randomText() {
  const n = 1 + Math.floor(rnd() * 14);
  let out = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
  return out.join(' ');
}
for (let i = 0; i < 4000; i++) CORPUS.push(randomText());

// ── compare ──────────────────────────────────────────────────────────────────
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let checks = 0, fails = 0;
const fail = (fn, input, o, n) => {
  fails++;
  if (fails <= 5) console.error(`MISMATCH ${fn}\n  input: ${JSON.stringify(input)?.slice(0, 160)}\n  old:   ${JSON.stringify(o)?.slice(0, 160)}\n  new:   ${JSON.stringify(n)?.slice(0, 160)}`);
};

for (const t of CORPUS) {
  for (const [name, fn] of [['valuesIn', 'valuesIn'], ['claimNumbers', 'claimNumbers'], ['nameClaims', 'nameClaims'], ['nameTokens', 'nameTokens']]) {
    const o = OLD[fn](t), n = NEW[fn](t);
    checks++; if (!eq(o, n)) fail(name, t, o, n);
  }
}

for (const v of [0, 1, -1, 0.01, 100, 124.3e9, 37.36, 37.4, 1e12, NaN, Infinity, -0.005]) {
  for (const h of [[], [0], [100], [124.3e9], [37.36], [NaN], [1, 2, 3]]) {
    const o = OLD.traced(v, h), n = NEW.traced(v, h);
    checks++; if (!eq(o, n)) fail('traced', { v, h }, o, n);
  }
}

const ALLOWED = [new Set(), new Set(['News']), new Set(['8-K', 'Form 4']), new Set(['10-Q', '10-K', '8-K', 'Form 4', 'FINRA', 'Congress', 'News', 'Market data'])];
const SOURCES = [undefined, null, '', 'News', '8-K', 'Form 4', 'FINRA', 'Congress', '10-Q', '10-K', 'Market data', 'Bloomberg', 'made-up'];
const COMPANIES = [undefined, null, '', 'Apple Inc', 'Tesla Motors Inc', 'Acme Pharmaceuticals Inc'];

for (const text of CORPUS.slice(0, 600)) {
  for (const src of SOURCES) {
    for (const allowed of ALLOWED) {
      for (const hay of HAYSTACKS.slice(0, 3)) {
        for (const company of COMPANIES.slice(0, 3)) {
          const b = { text, source: src };
          const hv = OLD.valuesIn(hay), hl = hay.toLowerCase();
          const o = OLD.validateBullet(b, company, hv, hl, allowed);
          const n = NEW.validateBullet(b, company, hv, hl, allowed);
          checks++; if (!eq(o, n)) fail('validateBullet', { text, src, company, hay }, o, n);
        }
      }
    }
  }
}

for (const k of ['GENERIC_CAPS', 'KNOWN_CATEGORIES', 'NAME_NOISE']) {
  const o = [...OLD[k]].sort(), n = [...NEW[k]].sort();
  checks++; if (!eq(o, n)) fail(k, k, o, n);
}

console.log(`grounding equivalence: ${checks.toLocaleString()} comparisons, ${fails} mismatches`);
if (fails) { console.error('NOT IDENTICAL — do not alter bulls-bears.'); process.exit(1); }
console.log('PROVEN IDENTICAL — safe to import the shared module in bulls-bears.');
