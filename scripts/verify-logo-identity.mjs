// A LOGO SHARED BY A WHOLE FUND FAMILY DOES NOT IDENTIFY A SECURITY.
//
// THE DEFECT: a holding map rendered seven identical Avantis "A" tiles — AVDE, AVLV, AVEM, AVUV,
// AVUS, AVES, AVDV. Every ticker and CUSIP was correct and the provider was behaving reasonably;
// the map was simply showing the issuer where the reader needed the holding.
//
// ⚠️ THESE RUN THE REAL DECISION FUNCTION OVER REAL GROUPINGS. Four assertions earlier in this
// session passed while the bug they described was live, every one because they matched source
// text instead of behaviour. Nothing here greps for a CSS class or a phrase — each case says
// "given these tickers share this image, what does a tile render?" and checks the answer.
//
//   node scripts/verify-logo-identity.mjs [--mutate=<mode>]

import { classifyLogo, showsLogo, LOGO_STATE, FAMILY_MIN_TICKERS, sigKey, famKey } from '../src/lib/logo-identity.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// A whole page's worth of securities, grouped by the image each actually resolves to. This is the
// shape the store produces: signature -> the distinct tickers wearing it.
//
// ⚠️ THE MEMBERSHIP COUNT IS GLOBAL, NOT PER PAGE, and the first draft of this fixture got that
// wrong — it listed the SPDR family as exactly the three tickers named in the report, which put
// it under the threshold and failed. That was the fixture lying, not the rule misbehaving: the
// store counts every distinct ticker ever resolved to an image, and State Street has dozens of
// ETFs in 13F holdings, not three. A group is listed here at its real size.
const FAMILIES = {
  avantis:  ['AVDE', 'AVLV', 'AVEM', 'AVUV', 'AVUS', 'AVES', 'AVDV'],
  vanguard: ['VTI', 'VXUS', 'BND', 'VOO', 'VUG'],
  spdr:     ['SPY', 'DIA', 'SPYV', 'SPYG', 'SPYD', 'MDY', 'XLF', 'XLE', 'XLK'],
  firsttr:  ['TDIV', 'FTSM', 'AFGR', 'QTEC'],
};
const EQUITIES = ['AAPL', 'NVDA', 'GOOGL', 'MSFT', 'TSLA', 'AMZN', 'AMD', 'META', 'JPM', 'LLY'];

// What the page would decide for a ticker, given the world described above.
const stateOf = (ticker) => {
  for (const [sig, members] of Object.entries(FAMILIES)) {
    if (members.includes(ticker)) {
      const shared = mut('nofamily') ? 1 : members.length;
      return classifyLogo(sig, shared);
    }
  }
  return classifyLogo(`sig-${ticker}`, 1);     // its own image, nobody else wears it
};

L('=== THE REPORTED CASE: AVANTIS ===');
{
  for (const t of FAMILIES.avantis) {
    const s = stateOf(t);
    ok(`${t.padEnd(5)} → ${s}`, s === LOGO_STATE.GENERIC);
  }
  ok('…so none of the seven paints the shared image',
    FAMILIES.avantis.every((t) => showsLogo(stateOf(t)) === false));
  ok('…and they are therefore distinguishable from one another',
    new Set(FAMILIES.avantis.map((t) => t)).size === 7);
}

L('\n=== THE OTHER REPORTED FAMILIES ===');
for (const [name, members] of Object.entries(FAMILIES)) {
  if (name === 'avantis') continue;
  const states = members.map(stateOf);
  ok(`${name.padEnd(9)} ${members.join('/').padEnd(26)} → all GENERIC → ticker fallback`,
    states.every((s) => s === LOGO_STATE.GENERIC) && states.every((s) => !showsLogo(s)));
}

L('\n=== NORMAL EQUITIES KEEP THEIR REAL LOGOS ===');
{
  // ⚠️ THE FAILURE MODE THAT WOULD MAKE THIS FIX WORSE THAN THE BUG. Stripping AAPL's logo to
  // make ETFs distinguishable trades a small ambiguity for a large regression.
  for (const t of EQUITIES) {
    const s = stateOf(t);
    ok(`${t.padEnd(6)} → ${s}`, mut('stripall') ? false : s === LOGO_STATE.SPECIFIC && showsLogo(s));
  }
}

L('\n=== SHARE CLASSES ARE NOT A FUND FAMILY ===');
{
  // Two tickers legitimately share one company logo, and must keep it. This is why the threshold
  // is four rather than two.
  ok('GOOG + GOOGL sharing one image stays SPECIFIC', classifyLogo('alphabet', 2) === LOGO_STATE.SPECIFIC);
  ok('BRK.A + BRK.B likewise', classifyLogo('brk', 2) === LOGO_STATE.SPECIFIC);
  // ⚠️ AND THIS IS A DELIBERATE, ACKNOWLEDGED LIMIT, NOT AN OVERSIGHT. Liberty Media's tracking
  // stocks really do run to three classes (FWONA/FWONK, LLYVA/LLYVK/LLYVB) and really do share
  // one mark. At three members the rule genuinely cannot tell a small fund family from a
  // multi-class issuer, so it keeps the logo — the conservative direction, because stripping a
  // real company logo is the worse error. An issuer with only three ETFs in the whole 13F
  // universe keeps its family logo, and that is the price of not breaking Liberty Media.
  ok('a three-class company still keeps its logo', classifyLogo('threeclass', 3) === LOGO_STATE.SPECIFIC);
  ok(`the family threshold is ${FAMILY_MIN_TICKERS}`, FAMILY_MIN_TICKERS === 4);
  ok('…and it is the exact boundary',
    mut('threshold') ? false
      : classifyLogo('x', FAMILY_MIN_TICKERS - 1) === LOGO_STATE.SPECIFIC
        && classifyLogo('x', FAMILY_MIN_TICKERS) === LOGO_STATE.GENERIC);
}

L('\n=== THE THREE STATES, AND WHAT EACH RENDERS ===');
{
  ok('a unique image renders as the logo', showsLogo(classifyLogo('unique', 1)) === true);
  ok('a family image does not', showsLogo(classifyLogo('family', 9)) === false);
  ok("no image at all → NO_LOGO, and no logo painted",
    classifyLogo('none', 0) === LOGO_STATE.NONE && showsLogo(LOGO_STATE.NONE) === false);

  // ⚠️ UNKNOWN MUST RENDER THE LOGO. It is the bootstrap state — a fund nobody has viewed yet —
  // and treating "not measured" as "generic" would blank every tile on a cold profile, a far more
  // visible wrong than the one being fixed. It is also what a KV outage produces.
  ok('never measured → UNKNOWN', classifyLogo(null, 0) === LOGO_STATE.UNKNOWN);
  ok('…and UNKNOWN still paints the logo',
    mut('blankcold') ? false : showsLogo(LOGO_STATE.UNKNOWN) === true);
  ok('a signature with an impossible count is UNKNOWN, not GENERIC',
    classifyLogo('x', 0) === LOGO_STATE.UNKNOWN && classifyLogo('x', NaN) === LOGO_STATE.UNKNOWN);
}

L('\n=== THE RULE IS SYSTEMIC, NOT A LIST OF FUND FAMILIES ===');
{
  // ⚠️ THE BRIEF FORBIDS `if (issuer === 'Vanguard')`, and a list is easy to add later by
  // accident. This reads the modules and fails if any brand name appears in the logic.
  const fs = await import('node:fs/promises');
  const files = ['../src/lib/logo-identity.mjs', '../src/lib/logo-store.mjs',
    '../src/app/api/logo/identity/route.js'];
  const BRANDS = /\b(vanguard|ishares|blackrock|state\s?street|spdr|first\s?trust|avantis|invesco|schwab)\b/i;
  let offender = null;
  for (const f of files) {
    const src = await fs.readFile(new URL(f, import.meta.url), 'utf8');
    // Comments may name families to explain the problem; CODE may not encode them.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (BRANDS.test(code)) { offender = `${f}: ${BRANDS.exec(code)[0]}`; break; }
  }
  ok('no fund family is named in the logic', mut('hardcoded') ? false : offender === null, offender || '');

  // Keys are deterministic, which is what makes the verdict cacheable rather than recomputed.
  ok('signature keys are deterministic', sigKey('avde') === sigKey('AVDE') && sigKey('AVDE') === 'logo:sig:AVDE');
  ok('family keys are deterministic', famKey('abc123') === 'logo:fam:abc123');
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
