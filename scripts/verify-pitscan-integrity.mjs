// PIT SCAN — end-to-end integrity for the LIVE path (/api/pitscan → /api/scan-board → panel).
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-pitscan-integrity.mjs
//
// ⚠️ WHY THE STUB HOOK. The entitlement assertions here IMPORT AND RUN lib/entitlements.js rather
// than grepping it, because grepping is what let the isRealtime regression ship: the module moved a
// symbol, re-exported six of nine names, and every call site kept the text
// `isRealtime(tier) && !beta` inside a catch that swallowed the resulting TypeError. Pit Scan's own
// `realtime` flag is that expression, so Pro and Elite were served delayed prices while 118 gating
// assertions stayed green. A test that cannot execute the decision cannot see that.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ⚠️ A NOTE ON EVERY NEGATIVE ASSERTION BELOW. This codebase documents its absences in prose — "No
// RVOL", "readPublishedBoard(), never rebuildBoard()" — so a search for the WORD finds the comment
// promising the thing is absent and reports a correct file as broken. Four assertions here did
// exactly that on the first run. A negative assertion must therefore match a CODE SHAPE (a property,
// a call, an import) that prose cannot satisfy.

const clerk = await import('../scripts/lib/clerk-stub.mjs');
const ent = await import('../src/lib/entitlements.js');
const boards = await import('../src/lib/scan/boards.mjs');
const rowsMod = await import('../src/lib/scan/scan-rows.mjs');
const snapMod = await import('../src/lib/scan/market-snapshot.mjs');

L('⚠️ the entitlement decision is EXECUTED, not grepped');
{
  // Every name Pit Scan's price path depends on must be a live value, not an absent re-export.
  for (const n of ['isRealtime', 'isProTier', 'resolveUserAccess', 'resolveUserTier', 'marketDataAccess']) {
    ok(`lib/entitlements.js exports a callable ${n}`, typeof ent[n] === 'function');
  }
  // ⚠️ THE EXACT EXPRESSION board-payload USES, run for every tier. `realtime` narrows what may be
  // served and must never widen it, so the two that matter most are the two negatives.
  const decide = async (identity) => {
    clerk.__setIdentity(identity);
    const { tier, beta } = await ent.resolveUserAccess();
    return { tier, beta: !!beta, realtime: ent.isRealtime(tier) && !beta };
  };
  const out = {
    signedOut: await decide({ userId: null }),
    free: await decide({ userId: 'u', publicMetadata: {} }),
    pro: await decide({ userId: 'u', publicMetadata: { plan: 'pro' } }),
    elite: await decide({ userId: 'u', publicMetadata: { plan: 'elite' } }),
    beta: await decide({ userId: 'u', publicMetadata: { beta: true } }),
    betaString: await decide({ userId: 'u', publicMetadata: { beta: 'true' } }),
  };
  ok('⚠️ signed out gets no real-time', out.signedOut.realtime === false, JSON.stringify(out.signedOut));
  ok('⚠️ Free gets no real-time', out.free.realtime === false, JSON.stringify(out.free));
  ok('⚠️ Pro DOES get real-time', out.pro.realtime === true, JSON.stringify(out.pro));
  ok('⚠️ Elite DOES get real-time', out.elite.realtime === true, JSON.stringify(out.elite));
  ok('⚠️ a beta tester gets Pro features on DELAYED data', out.beta.tier === 'pro' && out.beta.beta === true && out.beta.realtime === false, JSON.stringify(out.beta));
  ok('…and a non-boolean beta flag grants nothing', out.betaString.tier === 'free', JSON.stringify(out.betaString));
  ok('the board path reads that same expression', /isRealtime\(tier\) && !beta/.test(read('src/lib/scan/board-payload.js')));
}

L('⚠️ freshness says what the number actually is');
{
  const { FRESHNESS_LABEL, BOARD_STATUS_LABEL, freshnessLabel, boardStatusLabel, aggregateFreshness, isLiveEnough } = rowsMod;
  ok('a real-time print reads LIVE', freshnessLabel('realtime') === 'LIVE');
  ok('near-real-time also reads LIVE', freshnessLabel('near') === 'LIVE');
  ok('⚠️ a delayed print NEVER reads LIVE', freshnessLabel('delayed') === 'DELAYED');
  ok('⚠️ a completed session reads LAST CLOSE, not LIVE', freshnessLabel('eod') === 'LAST CLOSE');
  ok('⚠️ a price several sessions old reads LAST KNOWN, not DELAYED', freshnessLabel('stale') === 'LAST KNOWN');
  ok('no price carries no badge at all', freshnessLabel('unpriced') === null);
  // ⚠️ AN UNKNOWN PROVENANCE IS NOT A LIVE ONE — it must fall to the weakest label, never to LIVE.
  ok('⚠️ an unrecognised freshness falls to the weakest label', freshnessLabel('bogus') === 'LAST CLOSE' && boardStatusLabel('bogus') === 'LAST CLOSE');
  ok('there is no `mixed` row badge (a single price is never a mixture)', !('mixed' in FRESHNESS_LABEL));
  // Board aggregation: the two failures this had, in both directions.
  ok('⚠️ one unpriced row does not collapse a live board to LAST CLOSE', aggregateFreshness(['realtime', 'realtime', 'eod']) === 'mixed');
  ok('⚠️ …and a mixture is not labelled DELAYED either', boardStatusLabel(aggregateFreshness(['realtime', 'eod'])) !== 'DELAYED');
  ok('an all-live board is realtime', aggregateFreshness(['realtime', 'realtime']) === 'realtime');
  ok('realtime + near degrades to the weaker of the two', aggregateFreshness(['realtime', 'near']) === 'near');
  ok('⚠️ a board with no live price anywhere stays LAST CLOSE', boardStatusLabel(aggregateFreshness(['eod', 'eod'])) === 'LAST CLOSE');
  ok('delayed beats eod when nothing is live', aggregateFreshness(['delayed', 'eod']) === 'delayed');
  ok('an empty board has no freshness to claim', aggregateFreshness([]) === null);
  ok('isLiveEnough is true only for realtime/near',
    isLiveEnough('realtime') && isLiveEnough('near') && !isLiveEnough('delayed') && !isLiveEnough('eod') && !isLiveEnough('stale'));
}

L('⚠️ qualification boundaries — inclusive means inclusive, and nothing rounds into the board');
{
  const q = (row) => boards.qualifiesMovingNow(row, { now: Date.now() });
  const T = boards.THRESHOLDS.movingNow;
  const live = { freshness: 'realtime' };
  ok(`exactly ${T.minAbsChangePct}% qualifies`, q({ ...live, changePct: T.minAbsChangePct, last: 5 }).ok === true);
  ok('one tick below does not', q({ ...live, changePct: T.minAbsChangePct - 0.01, last: 5 }).ok !== true);
  // ⚠️ A 1.96% MOVE MUST NOT QUALIFY BECAUSE IT PRINTS AS "2.0%". The label rounds; the gate does not.
  ok('⚠️ a move that merely ROUNDS to the threshold does not qualify', q({ ...live, changePct: 1.96, last: 5 }).ok !== true);
  ok('the gate is symmetric in sign', q({ ...live, changePct: -T.minAbsChangePct, last: 5 }).ok === true);
  ok(`exactly $${T.minPrice} clears the price floor`, q({ ...live, changePct: 5, last: T.minPrice }).ok === true);
  ok('a cent below the floor is rejected as sub-dollar', q({ ...live, changePct: 50, last: T.minPrice - 0.01 }).reason === 'sub-dollar');
  // ⚠️ NON-POSITIVE IS ITS OWN FAILURE, not "small". If the floor ever moved, a $0.00 row must still go.
  ok('⚠️ a zero price is rejected as impossible, not as small', q({ ...live, changePct: 50, last: 0 }).reason === 'non-positive-price');
  ok('…and so is a negative price', q({ ...live, changePct: 50, last: -3 }).reason === 'non-positive-price');
  ok('⚠️ a multi-session-old price cannot claim to be moving now', q({ freshness: 'stale', changePct: 50, last: 5 }).reason === 'stale-price');
  for (const [label, v] of [['null', null], ['NaN', NaN], ['Infinity', Infinity], ['a string', '5']]) {
    ok(`a ${label} change is refused, not coerced`, q({ ...live, changePct: v, last: 5 }).ok !== true);
  }
  ok('an empty row is refused', q({}).ok !== true);
  // The structure path, and its own age limit.
  const withStructure = (pct, ageMin) => q({ ...live, changePct: pct, last: 5, structure: { label: 'ORB', at: new Date(Date.now() - ageMin * 60000).toISOString() } });
  ok(`a structure signal lowers the bar to ${T.minAbsChangePctWithStructure}%`, withStructure(T.minAbsChangePctWithStructure, 5).ok === true);
  ok('…but not below it', withStructure(T.minAbsChangePctWithStructure - 0.01, 5).ok !== true);
  ok(`⚠️ a structure signal older than ${T.maxStructureAgeMinutes}min is not "right now"`, withStructure(1.5, T.maxStructureAgeMinutes + 1).reason === 'structure-stale');
  ok('…and the row still qualifies on move size alone if it is big enough', withStructure(T.minAbsChangePct + 0.5, T.maxStructureAgeMinutes + 1).ok === true);
  // 13F can never be a live catalyst.
  ok('⚠️ institutional positioning can never qualify a catalyst row',
    boards.qualifiesCatalystsNow({ catalyst: { family: 'institutions', materiality: 1, publicAt: new Date().toISOString() } }).reason === '13f-is-not-a-catalyst');
}

L('⚠️ no RVOL, and nothing pretending to be one');
{
  // The consolidated payload's volume is the day's CUMULATIVE figure, so a ratio built on it would be
  // a fabrication whether or not the arithmetic is right. Nothing in the scan path may expose one.
  for (const f of ['src/lib/scan/market-snapshot.mjs', 'src/lib/scan/board-payload.js', 'src/lib/scan/scan-rows.mjs']) {
    // ⚠️ MATCHED AS A FIELD, NOT AS A WORD. These files DOCUMENT the absence — "No RVOL", "no 13F
    // occupancy … no RVOL" — so a search for the word finds the very comment promising it is absent
    // and reports a correct file as broken. What must not exist is a rvol/relativeVolume PROPERTY:
    // read, written, or returned. Prose cannot match `rvol:` or `.rvol`.
    const src = read(f);
    const asField = /\b(rvol|relativeVolume|unusualVolume|volumeRatio)\s*[:=]|\.(rvol|relativeVolume|unusualVolume|volumeRatio)\b/i;
    ok(`${f} exposes no rvol/relative-volume field`, !asField.test(src),
      (src.match(asField) || [''])[0]);
  }
  const caps = (await import('../src/lib/scan/runtime.js')).activeCapabilities();
  ok('the capability model states consolidated volume is unavailable', caps.consolidatedVolume === false);
  ok('…and live volume too', caps.liveVolume === false);
}

L('⚠️ a stale cached snapshot is refetched, never re-served as LIVE');
{
  const src = read('src/lib/scan/market-snapshot.mjs');
  // ⚠️ THE TTL WAS THE ONLY DEFENCE. The read computed ageMs and returned regardless, so a key that
  // stopped expiring would have kept printing LIVE over hours-old prices — and a TTL-less KV key is
  // not hypothetical in this product; the rate-limit counters were found in exactly that state.
  ok('the cache read bounds the age it will accept',
    /ageMs <= MAX_SNAPSHOT_CACHE_AGE_MS/.test(src) && /MAX_SNAPSHOT_CACHE_AGE_MS =/.test(src));
  ok('…and the bound is above the TTL but far below a single print\'s limit',
    snapMod.MAX_SNAPSHOT_CACHE_AGE_MS > snapMod.SNAPSHOT_TTL_SEC * 1000
    && snapMod.MAX_SNAPSHOT_CACHE_AGE_MS < snapMod.MAX_QUOTE_AGE_MS,
    `${snapMod.MAX_SNAPSHOT_CACHE_AGE_MS}ms vs TTL ${snapMod.SNAPSHOT_TTL_SEC * 1000}ms / print ${snapMod.MAX_QUOTE_AGE_MS}ms`);
  ok('a print older than the per-symbol limit is not a current price', snapMod.MAX_QUOTE_AGE_MS === 15 * 60 * 1000);
  // A provider failure must degrade to the quote path, never empty the board or claim realtime.
  const bp = read('src/lib/scan/board-payload.js');
  ok('⚠️ a snapshot failure degrades to the quote path rather than emptying the board',
    /snapshot = null;/.test(bp) && /A snapshot failure degrades to the quote path/.test(bp));
  ok('⚠️ …and a quote failure still renders the evidence boards', /quotes = \{\};/.test(bp));
  ok('a failed board read keeps its own degraded flag and message', /degraded: true, message:/.test(read('src/app/api/pitscan/route.js')));
}

L('⚠️ both scan routes are Pro-gated server-side');
{
  for (const f of ['src/app/api/pitscan/route.js', 'src/app/api/scan-board/route.js']) {
    const src = read(f);
    ok(`${f} refuses a non-Pro caller`, /isProTier\(tier\)/.test(src) && /pro_required/.test(src));
    ok(`…and resolves the tier server-side`, /await resolveUserTier\(\)/.test(src));
    ok(`…and never CDN-caches an entitlement-dependent answer`, /private, no-store/.test(src));
  }
}

L('⚠️ Alert and Watchlist are separate actions');
{
  const wl = read('src/app/api/watchlist/route.js');
  ok('⚠️ adding to a watchlist cannot subscribe to evidence alerts',
    !/evidence_alert|setSubscription|evidence-alerts/i.test(wl));
  const store = read('src/lib/alerts/evidence-alert-store.js');
  ok('⚠️ a repeated Alert click cannot create a second subscription', /on conflict \(user_id, ticker\) do update/.test(store));
  // ⚠️ AND CANNOT SKIP PENDING EVIDENCE. Re-saving an already-on subscription must not slide the
  // watermark, or a stray click silently drops everything that became public in between.
  ok('⚠️ …nor slide the watermark forward on an already-on subscription',
    /enabled_at = case when excluded\.enabled and not evidence_alert_subs\.enabled/.test(store));
  const alerts = read('src/app/api/evidence-alerts/route.js');
  ok('a signed-out caller cannot subscribe', /if \(!userId\) return \{ error: 'unauthorized', status: 401 \}/.test(alerts));
  ok('a Free caller cannot subscribe', /PRO_TIERS\.has\(tier\)/.test(alerts) && /pro_required/.test(alerts));
}

L('⚠️ evidence comes from the canonical engine, on the public clock');
{
  const bp = read('src/lib/scan/board-payload.js');
  // ⚠️ A READ NEVER COMPUTES. A Scan visitor must not be able to trigger a Consensus rebuild.
  // ⚠️ AS A CALL, NOT AS A WORD — the file's own comment reads "readPublishedBoard(), never
  // rebuildBoard()", so searching for the name finds the promise rather than a violation. What must
  // not exist is an awaited or imported rebuild.
  ok('the board is READ, never rebuilt by a visitor',
    /readPublishedBoard/.test(bp) && !/(await|import)[^\n]*rebuildBoard/.test(bp),
    (bp.match(/[^\n]*rebuildBoard[^\n]*/) || [''])[0].trim().slice(0, 70));
  const sel = read('src/lib/scan/catalyst-select.mjs');
  ok('⚠️ catalyst age is measured from PUBLIC availability, never the transaction',
    /publicAt` is when the information became PUBLICLY AVAILABLE/.test(sel) && /new Date\(c\.publicAt\)/.test(sel));
  ok('…and a candidate without a public timestamp is refused', /no-public-timestamp/.test(read('src/lib/scan/boards.mjs')));
  ok('the recovered-catalyst path also carries a public time', /catalystPublicTime/.test(bp));
  ok('⚠️ …and resolves its ticker through the existing security resolver, not a new one',
    /security_identity/.test(read('src/lib/scan/mover-catalyst.mjs')));
  // Supersession reaches Pit Scan through the Consensus board, which carries the guard.
  ok('⚠️ the Consensus board excludes retracted Form 4 filings',
    /superseded_by IS NULL|superseded_by,\s*''\)\s*=\s*''/.test(read('src/lib/consensus/board.mjs')));
}

L('one ticker, one row, deterministically');
{
  const src = read('src/lib/scan/boards.mjs');
  ok('⚠️ dedupe keeps the STRONGEST instance, so it cannot depend on input order',
    /if \(!prev \|\| scored\.boardScore > prev\.boardScore\) bySymbol\.set/.test(src));
  ok('⚠️ the sort is numeric, with a deterministic tiebreak rather than an unstable one',
    /\(b\.boardScore - a\.boardScore\) \|\| String\(a\.symbol\)\.localeCompare/.test(src));
}

L('the live Pit Scan is the only Pit Scan');
{
  const term = read('src/app/terminal/TerminalClient.jsx');
  ok('PitScanPanel is what the Terminal mounts', /<PitScanPanel onPick=/.test(term));
  // ⚠️ THE LEGACY BODY MUST STAY UNREACHABLE. Two implementations of one product is how the Terminal
  // and /scan eventually disagree about what is on the board.
  ok('⚠️ the legacy ScanBody is never rendered', !/<ScanBody/.test(term));
  ok('the panel asks /api/pitscan only for its self-description', /describe: '1'/.test(read('src/components/scan/PitScanPanel.jsx')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
