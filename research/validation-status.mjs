// INTERNAL RESEARCH STATUS OF PRODUCTION SCORING MODELS.
//
// ⚠️ RESEARCH METADATA ONLY. Nothing here is imported by src/, served by an API, or displayed to a
// user. Its purpose is narrower and more important than that: to stop future development from
// treating a shipped formula as empirically established simply because it has been shipped a long
// time.
//
// A score that has never been validated against forward outcomes is not wrong — it is UNKNOWN. The
// distinction disappears quickly once a number is on a page with a green badge next to it, which is
// exactly why it is written down here.

export const STATUS = Object.freeze({
  /** Validated against point-in-time forward outcomes, out of sample, and it held up. */
  VALIDATED: 'validated',
  /** Never tested against forward outcomes. Not a claim that it is wrong. */
  UNVALIDATED: 'unvalidated',
  /** Tested; the premise was not supported. Distinct from unvalidated, and stronger. */
  UNSUPPORTED: 'unsupported',
  /** Tested and contradicted. Nothing currently carries this. */
  REFUTED: 'refuted',
});

export const MODELS = Object.freeze([
  {
    id: 'pit_consensus_confluence',
    label: 'Pit Consensus (confluence score)',
    implementation: 'src/lib/confluence.js → computeConfluence()',
    status: STATUS.UNVALIDATED,
    // ⚠️ DO NOT SURFACE. The user has decided the status stays internal for now.
    userFacing: false,
    since: '2026-09-19',
    basis: [
      'Every constant in the formula — 20, 60, 250000, 25, 50, 100000, 18, 2.4, 1.6, the /3 and the',
      '90-day window — was chosen by judgement and has never been fitted or tested against forward',
      'outcomes.',
      'Experiment 001 tested the PREMISE (insider open-market buying, and 13F accumulation on top of',
      'it, over 63 trading days, sector-relative) and could not detect an edge: median −1.26%, hit',
      'rate 47%, both out-of-sample folds negative, every |t| below 1.1 against a Bonferroni',
      'threshold near 3.1.',
      'Experiment 001 ALSO turned out to have an invalid institutional arm — see caveats.',
    ],
    caveats: [
      'Experiment 001 is underpowered: effective N ≈ 65 after deflating for 63× label overlap. It',
      'does not refute the formula, it fails to support it.',
      'Experiment 001 computed 13F accumulation across quarter pairs whose earlier quarter held ONE',
      'fund, so those acc/red counts were fiction. Its institutional conclusions are not usable; its',
      'insider-only conclusions are unaffected.',
    ],
    knownIssues: [
      'Signal count is used twice: as the ≥2 gate AND as the 1.6/2.4 multiplier.',
      'The sum is divided by 3 even when only two families are present.',
      'fundScore = netFunds × 18 saturates at 100 for any large-cap, a strong size bias.',
      'Insider and congressional dollar values are not normalised by company size.',
      'clamp(0,100) is followed by a multiplier, so the published score actually ranges to 240.',
      'Bear direction reuses the bull constants; selling is not the inverse of buying.',
    ],
    // What would have to be true to move this to VALIDATED.
    exitCriteria: [
      'An evidence configuration that survives size, sector and momentum controls,',
      'out of sample, across multiple walk-forward folds, with a sample large enough to matter.',
    ],
  },
  {
    id: 'insider_conviction',
    label: 'Insider Conviction score',
    implementation: 'src/lib/conviction.server.js',
    status: STATUS.UNVALIDATED,
    userFacing: false,
    since: '2026-09-19',
    basis: ['Not yet tested against forward outcomes. Listed so it is not assumed validated by proximity.'],
    caveats: [], knownIssues: [], exitCriteria: [],
  },
]);

export const statusOf = (id) => MODELS.find((m) => m.id === id)?.status ?? null;

/** Anything a reader might mistake for validated. Used by the research suite, not by production. */
export const unvalidatedModels = () => MODELS.filter((m) => m.status !== STATUS.VALIDATED);
