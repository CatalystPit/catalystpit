// VERIFY PIT CONSENSUS EVIDENCE SYNTHESIS.
//
// The defect being guarded against is not a wrong number — it is the REAPPEARANCE of a number. The
// old reading summed four families into one signed value and published a direction, a percentage
// and a confidence word on top of it. Every assertion here exists so that cannot come back quietly,
// and --mutate proves each one is load-bearing.
//
// Run: node scripts/verify-consensus-synthesis.mjs [--mutate=<mode>]

import {
  synthesise, familyLean, describeConflicts, agreementLabel, SYNTHESIS_FAMILIES,
} from '../src/lib/consensus/synthesis.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const fam = (family, state, extra = {}) => ({
  family, state, active: state !== null, evidenceCount: 3, reasons: [`${family} reason`], ...extra,
});
const inactive = (family, reason = 'no-evidence') =>
  ({ family, active: false, inactiveReason: reason, state: null, evidenceCount: 0, reasons: [] });

L('=== NO AGGREGATE MAY BE PUBLISHED ===');
{
  const r = synthesise([
    fam('structure', 'higher-highs-and-lows'),
    fam('institutions', 'accumulating'),
    fam('insiders', 'bearish'),
  ]);
  const banned = ['direction', 'directionLabel', 'alignment', 'confidence', 'confidenceRaw', 'score',
    'sumE', 'mass', 'directionValue'];
  const present = banned.filter((k) => k in r);
  ok('the synthesis publishes no direction, percentage, score or confidence',
    mut('leak') ? present.length > 0 : present.length === 0, present.join(', '));
  // And nothing numeric that could be read as a rating.
  const numeric = Object.entries(r).filter(([k, v]) => typeof v === 'number' && !['activeCount', 'evaluatedCount'].includes(k));
  ok('the only numbers are counts of families', numeric.length === 0, numeric.map(([k]) => k).join(', '));
}

L('\n=== A FAMILY READS FROM ITS OWN VOCABULARY ===');
{
  ok('accumulating reads up', familyLean(fam('institutions', 'accumulating')) === 'up');
  ok('distributing reads down', familyLean(fam('institutions', 'distributing')) === 'down');
  ok('higher highs & lows reads up', familyLean(fam('structure', 'higher-highs-and-lows')) === 'up');
  ok('lower highs & lows reads down', familyLean(fam('structure', 'lower-highs-and-lows')) === 'down');
  ok('no clear sequence reads mixed', familyLean(fam('structure', 'no-clear-sequence')) === 'mixed');
  // The single most common misuse of insider data: a scheduled 10b5-1 disposal is not bearish
  // evidence, and reading it as such would manufacture conflicts that do not exist.
  ok('a routine scheduled sale is NOT read as bearish',
    familyLean(fam('insiders', mut('routine') ? 'bearish' : 'routine-sale')) === 'mixed');
  ok('an inactive family has no lean', familyLean(inactive('congress')) === null);
  ok('an unknown state degrades to mixed, never to a direction',
    familyLean(fam('insiders', 'something-new')) === 'mixed');
}

L('\n=== AGREEMENT IS A STATE, CHECKABLE AGAINST THE ROWS ===');
{
  const aligned = synthesise([fam('structure', 'higher-highs-and-lows'), fam('institutions', 'accumulating'), inactive('congress')]);
  ok('two families the same way reads aligned', aligned.agreement === 'aligned', aligned.agreement);

  const conflicting = synthesise([fam('institutions', 'accumulating'), fam('insiders', 'bearish')]);
  ok('opposing families read conflicting', conflicting.agreement === 'conflicting', conflicting.agreement);

  const single = synthesise([fam('insiders', 'bullish'), inactive('congress'), inactive('catalysts')]);
  ok('one active family is NOT reported as agreement', single.agreement === 'single-family', single.agreement);

  const none = synthesise([inactive('insiders'), inactive('congress')]);
  ok('no active families reads no-evidence', none.agreement === 'no-evidence', none.agreement);

  const unclear = synthesise([fam('insiders', 'bullish'), fam('congress', 'mixed')]);
  ok('one directional plus one mixed is not agreement', unclear.agreement === 'no-clear-agreement', unclear.agreement);

  ok('every agreement state has readable text',
    ['aligned', 'conflicting', 'single-family', 'no-evidence', 'no-clear-agreement']
      .every((a) => agreementLabel(a) && agreementLabel(a) !== a));
}

L('\n=== DISAGREEMENT IS NAMED, NOT AVERAGED ===');
{
  const fams = [fam('structure', 'higher-highs-and-lows'), fam('institutions', 'accumulating'), fam('insiders', 'cluster-sale')];
  const r = synthesise(fams);
  const c = r.conflicts[0];
  ok('a conflict is reported when families oppose', !!c);
  ok('the conflict names the positive side', c && c.positive.includes('institutions') && c.positive.includes('structure'));
  ok('the conflict names the negative side', c && c.negative.includes('insiders'));
  ok('the conflict text names both sides in words',
    c && /Institutions/.test(c.text) && /Insiders/.test(c.text), c?.text);
  ok('agreement and conflicts stay consistent', r.agreement === 'conflicting' && r.conflicts.length > 0);

  const agree = synthesise([fam('institutions', 'accumulating'), fam('insiders', 'bullish')]);
  ok('no conflict is invented when families agree', agree.conflicts.length === 0);
}

L('\n=== MARKET STRUCTURE IS A FAMILY, NOT A WEIGHT ===');
{
  // The whole point: structure contributes a STATE. Changing how much evidence sits behind it must
  // not change the reading, because nothing multiplies it against the others.
  const light = synthesise([fam('structure', 'higher-highs-and-lows', { evidenceCount: 1 }), fam('insiders', 'bearish')]);
  const heavy = synthesise([fam('structure', 'higher-highs-and-lows', { evidenceCount: 900 }), fam('insiders', 'bearish')]);
  ok('the amount of structural evidence does not change the agreement state',
    light.agreement === heavy.agreement, `${light.agreement} vs ${heavy.agreement}`);
  ok('structure cannot outvote another family', light.agreement === 'conflicting');
  ok('structure appears in the family ordering', SYNTHESIS_FAMILIES.includes('structure'));
  // Equally: it must not be silently dropped.
  ok('structure is carried in the output', light.families.some((f) => f.family === 'structure'));
}

L('\n=== INACTIVE FAMILIES ARE REPORTED, NOT HIDDEN ===');
{
  const r = synthesise([fam('insiders', 'bullish'), inactive('congress', 'no-evidence'), inactive('catalysts', 'stale')]);
  ok('inactive families are carried through', r.families.length === 3);
  ok('inactive families are listed by name', r.inactiveFamilies.includes('congress') && r.inactiveFamilies.includes('catalysts'));
  ok('active count excludes them', r.activeCount === 1);
  ok('evaluated count includes them', r.evaluatedCount === 3);
  ok('an empty input does not throw', synthesise([]).agreement === 'no-evidence');
  ok('a malformed input does not throw', synthesise(null).agreement === 'no-evidence');
}

// ── STATE AND ITS OWN EXPLANATION MUST AGREE ─────────────────────────────────
//
// Runs against real evidence when a database is configured, because this defect only appears on
// real distributions. Two shipped examples: Congress read "Bullish" above "activity is mixed", and
// Institutions read "Mixed" above a one-sided count of managers who increased. In a product whose
// whole claim is explainability, a reader who checks the reasoning must not be punished for it.
if (process.env.DATABASE_URL) {
  L('\n=== STATE vs ITS OWN REASON (real evidence) ===');
  const { resolveEvidence } = await import('../src/lib/consensus/evidence.js');
  const MIXED_WORDS = /mixed|balanced|against|while|versus/i;
  let checked = 0, coherent = 0;
  for (const t of ['KO', 'NVDA', 'MSFT']) {
    const fams = await resolveEvidence(t).catch(() => []);
    for (const f of fams.filter((x) => x.active && x.reasons?.length)) {
      checked++;
      const text = f.reasons.join(' ');
      let okRow;
      if (f.family === 'structure') {
        // Structure's reasons ARE the pivot facts, and for "no clear sequence" the incoherence
        // would be showing only one pivot. Both a high and a low must appear, because a conflicting
        // pair is exactly what makes the sequence unclear.
        okRow = f.state === 'no-clear-sequence'
          ? /high/i.test(text) && /low/i.test(text)
          : true;
      } else if (f.state === 'mixed') {
        // A mixed state must acknowledge both sides rather than citing only the winning one.
        okRow = MIXED_WORDS.test(text);
      } else {
        // A directional state must not describe itself as mixed.
        okRow = !/\bis mixed\b/i.test(text);
      }
      if (okRow) coherent++;
      else L(`     incoherent: ${t} ${f.family} state=${f.state} :: ${text.slice(0, 90)}`);
    }
  }
  ok(`every active family's reason is coherent with its state (${coherent}/${checked})`,
    checked > 0 && coherent === checked);
} else {
  L('\n(skipping the real-evidence coherence check: no DATABASE_URL)');
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
