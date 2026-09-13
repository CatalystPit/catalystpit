// Predicate-grounding regression suite.
//
// Every case below is a rewrite that uses ONLY real names and real figures — the kind the noun/number
// validators cannot catch. The point of this suite is that reversing a fact, swapping an event type
// or inventing a reason must be rejected, while a genuinely independent paraphrase must pass.
//
// Run: node scripts/verify-predicate.mjs

import { validateHeadline } from '../src/lib/headline-writer.mjs';
import { validatePredicate, directionConflict, eventTypeConflict, unsupportedCause } from '../src/lib/predicate-grounding.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

// reject(label, source, rewrite, expectedReason)
const reject = (label, src, out, reason) => {
  const v = validateHeadline(out, src, []);
  check(`${label} → rejected (${reason})`, !v.ok && v.reason === reason,
    v.ok ? 'ACCEPTED' : `got "${v.reason}"${v.detail ? ' / ' + v.detail : ''}`);
};
const accept = (label, src, out, tickers = []) => {
  const v = validateHeadline(out, src, tickers);
  check(`${label} → accepted`, v.ok, v.ok ? '' : `rejected: ${v.reason}${v.detail ? ' / ' + v.detail : ''}`);
};

// ── 1. direction flips ───────────────────────────────────────────────────────
sec('DIRECTION FLIPS');
const GUID = 'HEADLINE: Acme Corp raises full-year guidance after Q3 revenue of $1.2B\nAcme Corp reported third-quarter revenue of $1.2B and raised its full-year guidance.';
reject('raises -> cuts', GUID, 'Acme Corp cuts full-year guidance', 'direction');
reject('raises -> lowers', GUID, 'Acme Corp lowers its full-year outlook', 'direction');
reject('raises -> withdraws', GUID, 'Acme Corp withdraws full-year guidance', 'direction');

const BEAT = 'HEADLINE: Beta Industries beats third-quarter estimates\nBeta Industries reported earnings that beat analyst estimates for the third quarter.';
reject('beats -> misses', BEAT, 'Beta Industries misses third-quarter estimates', 'direction');
reject('beats -> falls short', BEAT, 'Beta Industries falls short of third-quarter estimates', 'direction');

const APPROVE = 'HEADLINE: FDA approves Gamma Therapeutics treatment\nThe FDA approved the treatment from Gamma Therapeutics.';
reject('approves -> rejects', APPROVE, 'FDA rejects Gamma Therapeutics treatment', 'direction');
reject('approves -> declines', APPROVE, 'FDA declines Gamma Therapeutics treatment', 'direction');

const BUY = 'HEADLINE: Delta Group acquires a stake in Epsilon Holdings\nDelta Group said it acquired a stake in Epsilon Holdings.';
reject('buys -> sells', BUY, 'Delta Group sells its stake in Epsilon Holdings', 'direction');
reject('buys -> divests', BUY, 'Delta Group divests its Epsilon Holdings stake', 'direction');

const EXPAND = 'HEADLINE: Zeta Systems expands its Ohio plant and hires workers\nZeta Systems said it will expand the Ohio plant.';
reject('expands -> contracts', EXPAND, 'Zeta Systems closes its Ohio plant', 'direction');

const RATE = 'HEADLINE: Fed raises rates by 25 basis points\nThe Federal Reserve raised rates by 25 basis points.';
reject('rate hike -> rate cut', RATE, 'Fed cuts rates by 25 basis points', 'direction');

// ── 2. event-type changes ────────────────────────────────────────────────────
sec('EVENT-TYPE CHANGES');
reject('guidance -> bankruptcy', GUID, 'Acme Corp files for bankruptcy protection', 'event_type');
reject('earnings -> acquisition', BEAT, 'Beta Industries agrees to acquire a competitor', 'event_type');

const TRIAL = 'HEADLINE: Theta Bio reports positive Phase 3 results\nTheta Bio said the Phase 3 study met its primary endpoint.';
reject('trial result -> FDA approval', TRIAL, 'Theta Bio wins FDA approval', 'event_type');

const CONTRACT = 'HEADLINE: Iota Defense wins a $40 million contract\nIota Defense was awarded a contract worth $40 million.';
reject('contract -> offering', CONTRACT, 'Iota Defense prices a $40 million offering', 'event_type');

const OFFERING = 'HEADLINE: Kappa Energy prices a $200 million offering\nKappa Energy priced a public offering of $200 million.';
reject('offering -> buyback', OFFERING, 'Kappa Energy authorizes a $200 million buyback', 'event_type');

const DIV = 'HEADLINE: Lambda Corp declares a quarterly dividend\nLambda Corp declared its quarterly dividend.';
reject('dividend -> buyback', DIV, 'Lambda Corp approves a share repurchase program', 'event_type');

// ── 3. unsupported causal claims ─────────────────────────────────────────────
sec('UNSUPPORTED CAUSAL CLAIMS');
reject('adds a demand story', GUID, 'Acme Corp raises guidance on strong AI demand', 'cause');
reject('adds a tariff cause', GUID, 'Acme Corp raises guidance due to tariff refunds', 'cause');
reject('adds a China cause', BEAT, 'Beta Industries beats estimates driven by China shipments', 'cause');
reject('adds a supply-chain cause', TRIAL, 'Theta Bio reports Phase 3 data amid supply chain constraints', 'cause');

// ── 4. correct paraphrases that MUST pass ────────────────────────────────────
sec('GENUINE PARAPHRASES — must pass');
accept('guidance, independent wording', GUID, 'Acme Corp lifts full-year outlook after $1.2B quarterly revenue');
accept('guidance, compressed', GUID, 'Acme Corp raises its full-year forecast');
accept('beat, restructured', BEAT, 'Beta Industries tops estimates for the third quarter');
accept('approval, actor-led', APPROVE, 'Gamma Therapeutics treatment clears FDA review');
accept('acquisition, restated', BUY, 'Delta Group takes a stake in Epsilon Holdings');
accept('contract, restated', CONTRACT, 'Iota Defense secures a $40 million award');
accept('offering, restated', OFFERING, 'Kappa Energy completes a $200 million share sale');
accept('dividend, restated', DIV, 'Lambda Corp approves its quarterly payout');
accept('trial, restated', TRIAL, 'Theta Bio study meets its primary endpoint in Phase 3');
accept('rate move, restated', RATE, 'Fed lifts benchmark rates by 25 basis points');
accept('supported cause is fine', GUID, 'Acme Corp raises guidance after Q3 revenue of $1.2B');

// ── 5. existing noun/number checks still fire ────────────────────────────────
sec('EXISTING CHECKS UNAFFECTED');
reject('invented number', GUID, 'Acme Corp raises guidance on $9.9B revenue', 'number');
reject('invented company', GUID, 'Acme Corp and Zorin Holdings raise guidance', 'name');
reject('unresolved ticker', GUID, '$ACME raises its full-year outlook', 'unresolved_ticker');
accept('resolved ticker allowed', GUID, '$ACME raises its full-year outlook', ['ACME']);
reject('hype verb', GUID, 'Acme Corp guidance soars for the full year', 'hype');

// ── 6. unit level ────────────────────────────────────────────────────────────
sec('UNIT LEVEL');
check('directionConflict detects a flip', !!directionConflict('cuts guidance', 'raises guidance'));
check('directionConflict ignores a match', !directionConflict('lifts guidance', 'raises guidance'));
check('directionConflict ignores absence', !directionConflict('names a new CEO', 'raises guidance'));
check('both directions present → no assertion',
  !directionConflict('raises guidance as revenue falls', 'raises guidance as revenue falls'));
check('eventTypeConflict detects a swap', !!eventTypeConflict('files for Chapter 11', 'raises guidance'));
check('eventTypeConflict allows a vaguer rewrite', !eventTypeConflict('Acme updates investors', 'raises guidance'));
check('eventTypeConflict rejects an added class', !!eventTypeConflict('Acme files for Chapter 11', 'Acme names a president'));
check('unsupportedCause flags an invented reason', !!unsupportedCause('raises guidance on strong AI demand', 'Acme raises full-year guidance'));
check('unsupportedCause allows a supported reason', !unsupportedCause('raises guidance after Q3 revenue', 'Acme raises guidance after Q3 revenue rose'));
check('stem matching tolerates word forms', !unsupportedCause('lifts outlook on quarterly revenue', 'Acme lifted outlook on third-quarter revenue'));
check('validatePredicate passes a clean rewrite', validatePredicate('Acme lifts full-year outlook', 'Acme Corp raises full-year guidance').ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
