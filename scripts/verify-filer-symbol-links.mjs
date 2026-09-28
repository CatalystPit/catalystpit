// A FILER-REPORTED SYMBOL IS NOT A TICKER, AND MUST NOT BE LINKED AS ONE.
//
//   node scripts/verify-filer-symbol-links.mjs
//
// ⚠️ THE DEFECT THIS PINS, found in pre-launch QA on real production data.
//
// Both 13F holdings and Form 4 rows carry a symbol field the FILER typed, and a meaningful share of
// them are not exchange symbols:
//
//   fund_holdings   61,698 of 17,160,159 — "BRK/A", "HEI/A", "MOG/A" (share classes in slash
//                   notation), "EA*", "BAC 7.25 PERP L", "2655957D" (a preferred line, a vendor id)
//   insider_trades   1,181 of    268,904 — "Z AND ZG", "NYSE: VTEX", "GEF, GEF-B", "(CALX)",
//                   "ASX:LNW", "MOGA/MOGB"
//
// Every one of them was pushed to /ticker/<raw>, where normalizeSymbol refuses it and the route
// answers 404 by design. A clickable row that leads to a 404 is worse than a row that does not
// invite the click.
//
// Slash notation is the SAME security under another convention — BRK/A is BRK.A, which is how the
// rest of the product spells a share class — so it converts. Everything else does not navigate.
import { readFileSync } from 'node:fs';
import { resolveFilerSymbol } from '../src/lib/ticker-symbol.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// THE rule, imported — not restated. A copy here would drift from the two call sites it guards.
const resolve = resolveFilerSymbol;

L('the rule');
for (const [input, expected] of [
  // Share classes: the same security, spelled the way 13F and Form 4 filers spell it.
  ['BRK/A', 'BRK.A'], ['HEI/A', 'HEI.A'], ['MOG/A', 'MOG.A'],
  // Already canonical.
  ['AAPL', 'AAPL'], ['BRK.B', 'BRK.B'], ['T', 'T'],
  // ⚠️ NOT SYMBOLS. Every one of these is a real value from production.
  ['EA*', null], ['LLYVK*', null], ['BAC 7.25 PERP L', null], ['2655957D', null], ['8HH', null],
  ['Z AND ZG', null], ['NYSE: VTEX', null], ['GEF, GEF-B', null], ['(CALX)', null],
  ['ASX:LNW', null], ['MOGA/MOGB', null], ['BIO BIO.B', null],
  // Nothing at all.
  [null, null], ['', null], ['   ', null], ['?', null],
]) {
  ok(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, resolve(input) === expected,
    `got ${JSON.stringify(resolve(input))}`);
}

L('both call sites apply it');
{
  const fund = read('../src/app/institutions/[slug]/FundProfile.jsx');
  const ins = read('../src/app/insiders/InsidersClient.jsx');
  for (const [name, src] of [['FundProfile', fund], ['InsidersClient', ins]]) {
    ok(`${name} imports the shared resolver`,
      /import \{ resolveFilerSymbol \} from '.*ticker-symbol\.mjs'/.test(src));
    ok(`${name} resolves before navigating`, /resolveFilerSymbol\((?:t|sym)\)/.test(src));
    // ⚠️ AND DOES NOT CARRY ITS OWN COPY OF THE RULE. Two components each doing their own
    // slash-to-dot is how "MOGA/MOGB" became the well-formed non-existent symbol "MOGA.MOGB".
    ok(`${name} does not reimplement the conversion`, !/replace\('\/', '\.'\)/.test(src));
    // ⚠️ AND THE PUSH IS GUARDED BY THE RESULT. This is the actual regression to catch: an edit that
    // navigates unconditionally again. Asserting the ABSENCE of a raw push cannot express it — the
    // fixed code pushes a variable too, and the name of that variable is not the point.
    ok(`${name} navigates only when the symbol resolved`,
      /if \((?:sym|t)\) router\.push\(`\/ticker\/\$\{encodeURIComponent\((?:sym|t)\)\}`\);/.test(src),
      'an unresolved filer value must not reach the URL');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
