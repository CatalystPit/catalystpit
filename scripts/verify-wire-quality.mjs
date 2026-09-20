// PIT WIRE LAUNCH QUALITY — suppression, defaults and event attribution.
//
// Each assertion corresponds to a defect measured on real production events, not a hypothetical:
//
//   82.8%  of recent display_ready events were opinion, listicles, retail explainers, low-impact PR
//          or law-firm solicitation — and the default view showed all of them, because the filters
//          that exclude them existed and nothing had them on.
//   8      separate rows for one Nscale IPO filing, because an event with a clear subject but no
//          ticker and no number falls through every dedupe layer.
//   3      different "entities" for that one event — nvidia-backed, british, ai — none of them the
//          company being reported on.
//
// Run: node scripts/verify-wire-quality.mjs [--mutate=<mode>]

import { decorate } from '../src/lib/wire-sources.mjs';
import { entityToken } from '../src/lib/news-normalize.mjs';
import { NOISE_FILTERS } from '../src/lib/wire-taxonomy.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const ev = (headline, extra = {}) =>
  ({ headline, summary: '', source: 'YAHOO', source_type: 'article', importance: 2, tickers: [], ...extra });
const noiseOf = (h, extra) => decorate(ev(h, extra)).wireNoise;

L('=== RETAIL EXPLAINER CONTENT IS SUPPRESSED ===');
{
  const junk = [
    'Why Zscaler Stock Rocketed Higher This Week',
    'Prediction: This Much Nvidia (NVDA) Stock Bought Today Could Be Worth $28,560 by 2030',
    'How To Earn $500 A Month From Worthington Enterprises Stock Ahead Of Q1 Earnings',
    'Ranking the Safest Dividend Stocks in the Energy Sector Right Now',
    'Should a 63-Year-Old Couple With $1.5 Million Convert to a Roth Before Medicare?',
    "Here's What Toast's 40% Margin Target Means for a $1,000 Investment Today",
    'This 27-Year-Old Left Wall Street to Create a Product That Gives People Time Back',
  ];
  for (const h of junk) {
    ok(`suppressed: ${h.slice(0, 54)}`,
      noiseOf(h).includes(mut('advice') ? 'nope' : 'advice'));
  }
}

L('\n=== LAW-FIRM SOLICITATION IS SUPPRESSED ===');
{
  for (const h of [
    'WIX INVESTOR DEADLINE APPROACHING: Faruqi & Faruqi, LLP Reminds Investors of Deadline',
    'AARD Shareholder Alert: Investigation Announced by Law Offices of Howard G. Smith',
    'Bragar Eagel & Squire, P.C. Reminds Investors That a Class Action Lawsuit Was Filed',
  ]) {
    ok(`suppressed: ${h.slice(0, 52)}`,
      noiseOf(h, { source: 'PRNEWSWIRE', source_type: 'press_release' }).includes(mut('promo') ? 'nope' : 'promo'));
  }
  // A REGULATOR acting is news, not solicitation. This is the line that keeps the filter narrow.
  ok('an SEC enforcement action is NOT suppressed as promotional',
    !noiseOf('SEC charges Acme Corp with accounting fraud', { source: 'SEC', source_kind: 'sec' }).includes('promo'));
  ok('a DOJ action is NOT suppressed as promotional',
    !noiseOf('DOJ announces settlement with Acme Corp', { source: 'DOJ' }).includes('promo'));
}

L('\n=== REAL EVENTS SURVIVE (no over-filtering) ===');
{
  const real = [
    ['Fed holds rates steady, signals one more cut in 2026', { source: 'FINANCIALJUICE', source_type: 'wire', importance: 3 }],
    ['Pfizer wins FDA approval for expanded Prevnar label', { importance: 3 }],
    ['Microsoft announces $60 billion share repurchase program', {}],
    ['Boeing secures $36.2B Korean Air order', {}],
    ['Zscaler shares jump on results and raised guidance', {}],
    ['Amerigo declares CAD 0.21 dividend', {}],
    ['Piper Sandler names Q2 Holdings top pick', {}],
    ['Nscale files for IPO on New York Stock Exchange', {}],
  ];
  for (const [h, extra] of real) {
    const n = noiseOf(mut('overfilter') ? 'Why This Stock Rocketed Higher This Week' : h, extra);
    ok(`kept: ${h.slice(0, 54)}`, !n.includes('advice') && !n.includes('promo'), n.join(','));
  }
}

L('\n=== THE SUPPRESSION KEYS ARE FILTERABLE ===');
{
  // Anything the server can tag must have a chip, or a user can never see what was hidden.
  const keys = new Set(NOISE_FILTERS.map((n) => n.key));
  for (const k of ['advice', 'promo', 'lowPr', 'transcripts', 'commentary', 'papers', 'govRoutine', 'crypto', 'foreign']) {
    ok(`'${k}' has a filter chip`, keys.has(k));
  }
}

L('\n=== EVENT ATTRIBUTION NAMES THE SUBJECT, NOT A QUALIFIER ===');
{
  // The dangerous case: attributing an event to a company that merely appears in the sentence.
  const t = entityToken(mut('entity') ? 'Nvidia-backed Nscale files for IPO' : 'Nvidia-backed Nscale files for IPO', []);
  ok('a "X-backed Y" headline attributes to Y, not X',
    mut('entity') ? t === 'nvidia-backed' : t === 'nscale', t);
  ok('a nationality qualifier is not the subject',
    entityToken('Chinese regulator fines Acme Corp', []) !== 'chinese',
    entityToken('Chinese regulator fines Acme Corp', []));
  ok('an ordinary headline still resolves', entityToken('Microsoft announces buyback', []) === 'microsoft');
  ok('a stated ticker always wins over any text heuristic',
    entityToken('Nvidia-backed Nscale files for IPO', ['NSCL']) === 'NSCL');
  // Degrading to nothing is correct; naming the wrong company is not.
  const amb = entityToken('British data centre group Nscale files for $35bn US listing', []);
  ok('an unresolvable subject yields nothing rather than a wrong one', amb === '' || amb.startsWith('nscale'), amb);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
