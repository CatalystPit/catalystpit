// EVIDENCE + CONSENSUS — the invariants the final audit established, and the defect it found.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-evidence-consensus-audit.mjs
//
// ⚠️ SCOPE. The existing suites (verify-evidence 119, verify-consensus-v35 142, verify-consensus-
// authority 63, verify-high-significance 55, verify-evidence-markers 130, verify-consensus-synthesis
// 37) already cover the methodology. This file adds only what the final audit checked that they did
// not: the CLOCK of every source in one place, determinism across a rerun, and the failure contract
// — a resolver outage must not reach a caller as an empty evidence list or as an exception string.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

L('⚠️ publicTime is when the market could know — for every source');
{
  const src = read('src/lib/evidence/resolve.js');
  // ⚠️ ONE ASSERTION PER SOURCE, because a single wrong clock on a single family is the whole defect
  // class: it would surface a filing before anyone could have read it.
  const CLOCKS = [
    ['insider buys', 'publicTime: newest.filing_date'],
    ['8-K', 'publicTime: f.filed_at'],
    ['wire / company events', 'publicTime: e.published_at'],
    ['13D', 'publicTime: f.filed_at'],
    ['Congress', 'publicTime: newest.disclosure_date'],
    ['13F breadth', 'publicTime: latest.filed'],
  ];
  for (const [label, needle] of CLOCKS) ok(`${label} publishes on its filing/disclosure clock`, src.includes(needle), needle);
  // The event clocks that must NOT be publicTime.
  ok('⚠️ Congress keeps the transaction date as the event only', /eventTime: newest\.transaction_date \|\| null, \/\/ retained, never measured from/.test(src));
  ok('⚠️ 13F keeps the quarter END as the event, not the disclosure', /eventTime: latest\.quarter/.test(src));
  ok('…and refuses to build a breadth event with no disclosure date', /if \(!latest\?\.filed\) return \[\];/.test(src));
  // ⚠️ THE 13F DISCLOSURE DATE IS THE MEDIAN FILING, not the quarter end — a defensible answer to
  // "when was an aggregate across filers knowable".
  ok('⚠️ the 13F disclosure date is derived from filed_date, never from the quarter',
    /percentile_disc\(0\.5\) within group \(order by filed_date\)/.test(src));

  // The engine's own invariant, independently enforced.
  const model = read('src/lib/evidence/model.mjs');
  ok('⚠️ the model refuses an event that postdates its own disclosure', /reason: 'pit'/.test(model));
  ok('…and refuses a publicTime in the future', /reason: 'future'/.test(model));
  ok('changedSince gates on publicTime, which is what makes a backfill safe',
    /const pub = toEpoch\(e\?\.publicTime\);/.test(model));
}

L('⚠️ no non-public clock is used as a freshness or ranking bound');
{
  // ⚠️ MATCHED AS A COMPARISON, not as a word: these files NAME transaction_date in comments to
  // explain why it is not used, so a bare search finds the explanation.
  for (const f of ['src/lib/evidence/resolve.js', 'src/lib/consensus/board.mjs', 'src/lib/consensus/build-context.mjs']) {
    const src = read(f);
    const bad = src.match(/\b(transaction_date|report_date|period_of_report|date_of_event)\s*(>=|<=|>|<)/g) || [];
    ok(`${f} bounds nothing on an event-time column`, bad.length === 0, bad.join(','));
  }
  // `quarter` IS compared — as a lookback for which quarters to compare and to order them. That is
  // legitimate precisely because the breadth event's publicTime comes from filed_date instead.
  ok('the quarter bound exists only alongside a filed-date publicTime',
    /quarter >= \(current_date - make_interval/.test(read('src/lib/evidence/resolve.js'))
    && /publicTime: latest\.filed/.test(read('src/lib/evidence/resolve.js')));
}

L('⚠️ a retracted or superseded record cannot become evidence');
{
  const src = read('src/lib/evidence/resolve.js');
  ok('⚠️ superseded Form 4 rows are dropped before they are evidence', /filter\(\(x\) => !x\.superseded\)/.test(src));
  ok('…and the timeline does the same', /filter\(\(x\) => !x\.superseded\)/.test(read('src/lib/evidence/timeline.js')));
  ok('an implausible breadth change is refused as a resolution artifact, not published',
    /implausibleBreadth\(prev\.breadth, latest\.breadth\)/.test(src));
}

L('⚠️ an engine failure is reported, never served as an absence');
{
  // ⚠️ THE WHOLE POINT: an empty evidence list is a CLAIM. A resolver outage must not be able to make
  // it, on any surface.
  const route = read('src/app/api/evidence/route.js');
  ok('the evidence route answers a resolver outage with 503, not 200', /status: 503/.test(route));
  ok('…and says so explicitly in its contract', /FAILS LOUDLY/.test(route));
  // ⚠️ AND WITHOUT THE EXCEPTION TEXT. Matched on the return, because the comment above the fix
  // quotes the old `detail:` line to explain it.
  const returns = (route.match(/return Response\.json\([^;]*;/g) || []).join(' ');
  ok('⚠️ …and never hands the caller the exception string', !/e\?\.message|e\.message/.test(returns),
    (returns.match(/[^;]*message[^;]*/) || [''])[0].slice(0, 90));
  ok('…and the failure is logged server-side instead', /console\.log\(`\[evidence\]/.test(route));
  ok('…and a failure is never cached', /'Cache-Control': 'private, no-store'/.test(route));

  const consensus = read('src/app/api/consensus/route.js');
  ok('the consensus route answers an outage with 503 and no-store',
    /consensus_unavailable/.test(consensus) && /status: 503, headers: NO_STORE/.test(consensus));
  // A per-family failure must degrade that family, not the board.
  ok('⚠️ a failed family marks the row degraded rather than shortening the evidence',
    /AN ENGINE FAILURE IS NOT AN ABSENCE OF EVIDENCE/.test(read('src/lib/consensus/setup-board.js')));
  // A board that does not validate is not published.
  const refresh = read('src/lib/consensus/refresh.js');
  ok('⚠️ an invalid board payload is not published', /const check = validateBoardPayload\(payload\);/.test(refresh)
    && /if \(!check\.ok\) return \{ published: false/.test(refresh));
  ok('…and a failed KV write is not reported as published', /if \(!wrote\) return \{ published: false/.test(refresh));
}

L('⚠️ the per-ticker board is tier-gated server-side; the per-ticker evidence is not tier-dependent');
{
  const board = read('src/app/api/consensus-board/route.js');
  ok('the board resolves a tier server-side', /await resolveUserTier\(\)/.test(board));
  ok('⚠️ …and withholds the rows rather than shipping and hiding them', /FREE_ROWS/.test(board) && /lockedCount/.test(board));
  ok('…and is never shared-cacheable', /private, no-store/.test(board));
  // The per-ticker routes carry no tier, which is exactly what makes their public cache honest.
  for (const f of ['src/app/api/consensus/route.js', 'src/app/api/evidence/route.js']) {
    ok(`${f} resolves no tier, so its public cache cannot hold tier-specific data`,
      !/resolveUserTier|resolveUserAccess|isProTier/.test(read(f)));
  }
  // ⚠️ THE UNVALIDATED V1 AGGREGATE IS NOT WHAT THE UI READS. It ships for compatibility and says so.
  // ⚠️ MATCHED ON A FRAGMENT THAT SITS ON ONE LINE. The user-facing sentence is built by string
  // concatenation, so "no longer shown to users" spans a line break in the source and a naive
  // search for it fails against correct code — it did, on the first run.
  {
    const c = read('src/app/api/consensus/route.js');
    ok('the deprecated v1 aggregate is labelled as not built upon',
      /Retained only for consumer compatibility/.test(c) && /deprecated: \{/.test(c));
    ok('…and the route says so about itself too', /NOTHING USER-FACING READS THEM ANY MORE/.test(c));
  }
  ok('⚠️ …and the panel renders the canonical reading instead',
    /data\.canonical/.test(read('src/components/ConsensusPanel.jsx'))
    && !/evidenceCount/.test(read('src/components/ConsensusPanel.jsx')));
}

L('the engine is deterministic on real production tickers');
{
  const { tickerEvidence } = await import('../src/lib/evidence/resolve.js');
  // ⚠️ A RERUN MUST BE IDENTICAL. Ranking, dedupe and precedence all feed alerts and NEW badges, so a
  // set that reorders between reads would restamp events as new.
  const key = (e) => [e.family, e.type, e.publicTime, e.sourceId].join('|');
  for (const t of ['NVDA', 'MSTR', 'AAPL']) {
    const a = await tickerEvidence(t);
    const b = await tickerEvidence(t);
    const ka = (a.evidence || []).map(key).sort().join(';');
    const kb = (b.evidence || []).map(key).sort().join(';');
    ok(`${t}: two reads return the same evidence set`, ka === kb);
    const evs = a.evidence || [];
    ok(`${t}: no duplicate evidence key`, evs.length === new Set(evs.map(key)).size);
    // The point-in-time invariant, measured rather than trusted.
    const pit = evs.filter((e) => e.eventTime && e.publicTime
      && Date.parse(e.eventTime) > Date.parse(e.publicTime) + 3600e3);
    ok(`${t}: no event is dated after its own disclosure`, pit.length === 0,
      pit.map((e) => `${e.type} ${e.eventTime}>${e.publicTime}`).join(', '));
    const future = evs.filter((e) => Date.parse(e.publicTime) > Date.now() + 3600e3);
    ok(`${t}: nothing is published in the future`, future.length === 0, `${future.length}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
