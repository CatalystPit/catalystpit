// THE CONVICTION WRITE PATH — the thing that was missing, and the guard that reports it if it
// goes missing again.
//
// ⚠️ WHAT ACTUALLY HAPPENED, BECAUSE IT SHAPES EVERY ASSERTION BELOW.
//
// The engine was never broken. Its inputs were present. Its last run completed cleanly — the
// graded ids ran 81 to 1,772,281 with ZERO ungraded rows beneath that ceiling, which is the
// signature of a job that finished and was never started again. The only caller was a developer
// typing `node scripts/score-conviction.mjs`: no cron entry, no route, no caller in src/. Grading
// stopped because nobody ran it, and the product had no way to say so — a NULL band meant both
// "we do not score this kind of trade" and "we have not scored this one yet", so fourteen days of
// ungraded filings looked exactly like fourteen days of ineligible ones.
//
// So this file asserts three things: the engine is untouched, the run is scheduled and idempotent,
// and staleness is now detectable rather than invisible.
//
// Run: node --conditions react-server scripts/verify-conviction-pipeline.mjs

import { readFileSync } from 'node:fs';
import {
  OM_BUY, SCOREABLE, CONTEXT_STATEMENTS, scoreUngraded, convictionCoverage, STALE_AFTER_DAYS,
} from '../src/lib/insider/conviction-pipeline.mjs';
import { scoreConviction, bandFor, isConvictionEligible } from '../src/lib/conviction.server.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
// ⚠️ MATCHED AGAINST CODE, NOT PROSE — for the third time in this codebase. The comments here
// name the very things being forbidden ("there is no cursor to corrupt", "s.factors stays in this
// process"), so three assertions about the IMPLEMENTATION were satisfied, or defeated, by the
// explanation of the implementation.
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

const engine = read('../src/lib/conviction.server.js');
const pipeline = read('../src/lib/insider/conviction-pipeline.mjs');
const cron = read('../src/app/api/cron/score-conviction/route.js');
const contextScript = read('../scripts/build-insider-context.mjs');
const insidersApi = read('../src/app/api/insiders/route.js');
const insidersUi = read('../src/app/insiders/InsidersClient.jsx');
const watchlist = read('../src/lib/terminal/watchlist-changes.mjs');

L('⚠️ THE METHODOLOGY IS UNTOUCHED');
{
  // ⚠️ THIS WAS A PLUMBING FAILURE, SO NOTHING ABOUT THE SCORE MAY HAVE MOVED. If a weight or a
  // band edge drifted while "fixing" the pipeline, every historical score would silently mean
  // something new and no one would be able to tell which era a row came from.
  ok('⚠️ the six factor weights are unchanged',
    /seniority: 0\.15/.test(engine) && /sizeVsSelf: 0\.20/.test(engine) && /ownership: 0\.17/.test(engine)
    && /rarity: 0\.19/.test(engine) && /cluster: 0\.13/.test(engine) && /scale: 0\.16/.test(engine));
  ok('⚠️ the de-minimis floor is unchanged', /const DE_MINIMIS = 50000;/.test(engine));
  ok('⚠️ the seniority ladder is unchanged',
    /CEO: 1\.00, CFO: 0\.92, SENIOR_OFFICER: 0\.78, CHAIR: 0\.74/.test(engine));
  ok('⚠️ the band edges are unchanged',
    bandFor(39) === 'LOW' && bandFor(40) === 'MODERATE' && bandFor(59) === 'MODERATE'
    && bandFor(60) === 'HIGH' && bandFor(74) === 'HIGH' && bandFor(75) === 'VERY HIGH'
    && bandFor(89) === 'VERY HIGH' && bandFor(90) === 'EXTREME');
  // ⚠️ ONE ENGINE. The fix must not have grown a second scorer.
  ok('⚠️ the pipeline imports the engine rather than re-implementing it',
    /import \{ scoreConviction, convictionTags, isConvictionEligible \} from '\.\.\/conviction\.server\.js'/.test(pipeline)
    && !/const W = \{/.test(pipeline) && !/DE_MINIMIS/.test(pipeline) && !/SENIORITY/.test(pipeline));
  ok('…and the cron imports the pipeline rather than the engine directly',
    /from '\.\.\/\.\.\/\.\.\/\.\.\/lib\/insider\/conviction-pipeline\.mjs'/.test(cron)
    && !/conviction\.server/.test(code(cron)));
}

L('⚠️ ELIGIBILITY STILL MEANS WHAT IT MEANT');
{
  const buy = { transaction_code: 'P', is_derivative: false, superseded_by: null, total_value: 250000, shares: 1000 };
  ok('an open-market purchase is eligible', isConvictionEligible(buy));
  // ⚠️ A SALE MUST NEVER CARRY A BULLISH SCORE. NULL on a sell is the designed answer, not a gap.
  ok('⚠️ a sale is not eligible and scores null',
    !isConvictionEligible({ ...buy, transaction_code: 'S' })
    && scoreConviction({ ...buy, transaction_code: 'S' }, null) === null);
  ok('⚠️ a grant, exercise or tax withholding is not eligible',
    ['A', 'M', 'F', 'G'].every((c) => !isConvictionEligible({ ...buy, transaction_code: c })));
  ok('a derivative or superseded row is not eligible',
    !isConvictionEligible({ ...buy, is_derivative: true })
    && !isConvictionEligible({ ...buy, superseded_by: '0001' }));
  ok('a row without value or shares is not eligible',
    !isConvictionEligible({ ...buy, total_value: 0 }) && !isConvictionEligible({ ...buy, shares: 0 }));

  // ⚠️ MISSING CONTEXT IS A DOCUMENTED DEFAULT, NOT A FABRICATION. The engine states this: an
  // unknown ownership change "should not be punished as though the stake barely moved". So a row
  // with no context still scores — it simply scores as unremarkable.
  const bare = scoreConviction(buy, null, {});
  ok('⚠️ a row with no context still scores, from documented neutral defaults',
    bare && Number.isFinite(bare.score) && bare.score > 0);
  ok('…and the SQL predicates match the engine\'s own eligibility',
    /transaction_code = 'P'/.test(SCOREABLE) && /is_derivative = false/.test(SCOREABLE)
    && /superseded_by IS NULL/.test(SCOREABLE) && /total_value > 0/.test(SCOREABLE) && /shares > 0/.test(SCOREABLE));
  ok('⚠️ context is built over the same definition of a buy',
    /transaction_code = 'P'/.test(OM_BUY) && /owner_cik IS NOT NULL/.test(OM_BUY));
}

L('⚠️ THE RUN IS SCHEDULED, BOUNDED AND RESUMABLE');
{
  const vercel = JSON.parse(read('../vercel.json'));
  // ⚠️ THE ROOT CAUSE, ASSERTED. There was no entry here, and that is the entire bug.
  ok('⚠️ conviction scoring now has a cron entry',
    vercel.crons.some((c) => c.path === '/api/cron/score-conviction'));
  ok('…with room to run', vercel.functions?.['src/app/api/cron/score-conviction/route.js']?.maxDuration >= 60);
  ok('the cron follows the existing auth convention', /x-vercel-cron/.test(cron) && /CRON_SECRET/.test(cron));
  ok('⚠️ context runs before scoring, because the score reads it',
    /refreshContext\(run\)[\s\S]{0,600}scoreUngraded\(run/.test(cron));

  // ⚠️ KEYSET PAGINATION, AND THE BUG IT FIXES WAS REAL. The first version relied on the work
  // queue shrinking — true while the gate is `conviction IS NULL`, false the moment rescore drops
  // it. A rescore run reported "scored 60000" having written the same 2,000 rows thirty times.
  ok('⚠️ paging advances an id watermark rather than trusting the predicate to shrink',
    /AND id > \$1/.test(pipeline) && /afterId = rows\[rows\.length - 1\]\.id;/.test(pipeline));
  ok('⚠️ …so progress does not depend on which rows happen to be written',
    !/OFFSET/.test(pipeline));
  ok('the run is bounded in rows and in wall time',
    /limit = 20000/.test(pipeline) && /budgetMs/.test(pipeline) && /Date\.now\(\) - started > budgetMs/.test(pipeline));
  // ⚠️ RESUMABILITY IS THE QUERY, NOT A CURSOR. A cursor that advances during a partial failure
  // loses rows silently; a predicate cannot.
  ok('⚠️ the work queue is a predicate, so a killed run leaves the rest selected',
    /AND conviction IS NULL/.test(code(pipeline)) && !/last_processed|cursor|checkpoint/i.test(code(pipeline)));
  ok('⚠️ a routine run never rescores history unless explicitly asked',
    /rescore = false/.test(pipeline) && /const gate = rescore \? '' : 'AND conviction IS NULL'/.test(pipeline));
  ok('⚠️ a row the engine declines is skipped and left NULL, never given a default score',
    /if \(!s\) \{ skipped\+\+; continue; \}/.test(pipeline)
    && !/conviction = 0|band: 'LOW'|score: 50/.test(pipeline));
  ok('only score, band and tags are persisted — never a factor breakdown',
    /SET conviction = v\.score, conviction_band = v\.band,\s*\n?\s*conviction_tags = v\.tags, conviction_at = now\(\)/.test(pipeline)
    && !/factors/.test(code(pipeline).split('export async function scoreUngraded')[1] || ''));
}

L('⚠️ ONE DEFINITION OF THE CONTEXT STATEMENTS');
{
  ok('there are four context statements', CONTEXT_STATEMENTS.length === 4);
  ok('each is a label and SQL text',
    CONTEXT_STATEMENTS.every(([l, t]) => typeof l === 'string' && typeof t === 'string' && t.length > 50));
  // ⚠️ THE SCRIPT AND THE CRON RUN THE SAME SQL. Copying it would put "what is an open-market buy"
  // in two files no test compares — the drift that made a $10M CEO purchase promotable in one
  // resolver and not the other.
  ok('⚠️ the manual script imports them instead of keeping its own copy',
    /import \{ OM_BUY, CONTEXT_STATEMENTS \} from '\.\.\/src\/lib\/insider\/conviction-pipeline\.mjs'/.test(contextScript)
    && /for \(const \[label, text\] of CONTEXT_STATEMENTS\)/.test(contextScript));
  ok('…and no longer defines OM_BUY itself', !/^const OM_BUY = /m.test(contextScript));
}

L('⚠️ STALENESS IS DETECTABLE, AND UNKNOWN IS NOT FRESH');
{
  ok('a staleness threshold is stated', Number.isFinite(STALE_AFTER_DAYS) && STALE_AFTER_DAYS > 0);
  ok('⚠️ coverage compares graded-through against the newest eligible filing',
    /graded_through/.test(pipeline) && /newest_eligible/.test(pipeline) && /pending/.test(pipeline));
  // ⚠️ THE FAILURE MODE THAT MATTERS: a coverage read that cannot answer must not report "fine".
  ok('⚠️ a failed coverage read reports current:false, never current:true',
    /catch \{[\s\S]{0,300}current: false[\s\S]{0,40}\};/.test(pipeline));
  ok('…and unknown dates cannot produce current:true',
    /current: gradedThrough != null && lagDays != null && lagDays <= STALE_AFTER_DAYS/.test(pipeline));

  // ⚠️ THE PRODUCT MUST NOT SHOW OLD CONVICTION AS CURRENT.
  ok('⚠️ the API ships coverage alongside the conviction summary',
    /conviction: await cachedCoverage\(\)/.test(insidersApi));
  ok('…cached, so a freshness read is not a query per request', /_covAt < 60_000/.test(insidersApi));
  ok('⚠️ the "highest conviction" tile stands down when grading is behind',
    /data\.conviction && data\.conviction\.current === false \? \[\] : \[/.test(insidersUi));
  ok('⚠️ …and the page says so, with the date grading actually reaches',
    /Conviction scoring is currently behind/.test(insidersUi) && /gradedThrough/.test(insidersUi));
  ok('⚠️ no neutral placeholder score is ever substituted',
    !/conviction: 50|band: 'MODERATE'/.test(insidersUi));
}

L('⚠️ THE WATCHLIST DEPENDENCY DEGRADES SAFELY — UNCHANGED');
{
  // ⚠️ NOT TOUCHED BY THIS FIX, AND THAT IS THE POINT. notable-insider reads conviction_band; a
  // NULL band simply means "not notable", so the row falls through to the ordinary insider entry
  // rather than vanishing or being promoted on a guess.
  ok('⚠️ notable insider is still gated on the conviction model\'s own bands',
    /NOTABLE_BANDS = Object\.freeze\(\['HIGH', 'VERY HIGH', 'EXTREME'\]\)/.test(watchlist));
  ok('⚠️ …and a null band means not-notable, never a default promotion',
    /notable: NOTABLE_BAND_SET\.has\(String\(row\.convictionBand \|\| ''\)/.test(watchlist));
  ok('⚠️ a demoted insider still has an ordinary row to fall back to',
    /\{ id: 'notable-insider', kind: CHANGE\.INSIDER, when: NOTABLE, days: 7 \}/.test(watchlist)
    && /\{ id: 'insider', kind: CHANGE\.INSIDER, when: ANY, days: 14 \}/.test(watchlist));
}

L('⚠️ SCORING IS DETERMINISTIC');
{
  // ⚠️ IDEMPOTENCE STARTS HERE. If the same row scored differently twice, no amount of careful
  // paging would make a re-run safe.
  const row = {
    transaction_code: 'P', is_derivative: false, superseded_by: null,
    total_value: 1_200_000, shares: 10_000, title: 'Chief Executive Officer',
    is_officer: true, owner_cik: '1', ownership_type: 'D', rule_10b5_1: false,
    is_first_om_buy: true, months_since_prev_buy: null, om_buys_12m: 1,
    cluster_insiders_10d: 3, ownership_increase_pct: 22.5,
  };
  const person = { om_buy_median: 400_000, om_buy_count: 4 };
  const a = scoreConviction(row, person, { marketCap: 2e9 });
  const b = scoreConviction(row, person, { marketCap: 2e9 });
  ok('⚠️ the same inputs produce the same score and band',
    a && b && a.score === b.score && a.band === b.band, `${a?.score}/${b?.score}`);
  ok('…and a CEO first-buy of $1.2M lands above the token floor', a.score > 40, String(a?.score));
  // ⚠️ A TOKEN PURCHASE CANNOT REACH THE TOP BANDS, however flattering its ratios.
  const token = scoreConviction({ ...row, total_value: 20_000, shares: 200 }, person, { marketCap: 2e9 });
  ok('⚠️ a sub-$50K purchase is capped below VERY HIGH',
    token.score <= 74 && token.band !== 'VERY HIGH' && token.band !== 'EXTREME', `${token.score} ${token.band}`);
  ok('scoreUngraded is exported and takes a run adapter', typeof scoreUngraded === 'function');
  ok('convictionCoverage is exported', typeof convictionCoverage === 'function');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
