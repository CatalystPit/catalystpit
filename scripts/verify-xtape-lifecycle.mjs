// The X Tape must actually finish its first build — on EVERY page, not only the Terminal.
//
// This models the component's two interacting state machines (the build effect and the refresh
// scheduler) against a fake clock, with X's per-visitor syndication rate limit in the loop. It is
// the companion to verify-xtape-swap.mjs, which covers what the DOM looks like DURING a swap; this
// one covers whether a build is ever allowed to finish at all.
//
// THE BUG IT PINS. builtAtRef started at 0 while the clock reads ~1.7e12, so before the first
// successful build every staleness test in shouldBuild() was true: "older than 10 minutes" and
// "older than 60 seconds" are both trivially true of 1970. The scheduler therefore demanded a
// rebuild on its very first 2s tick, while the first build was still running. Bumping the nonce
// re-runs the build effect, and React runs the previous effect's cleanup first — so the tick
// CANCELLED the in-flight build and started another one. A cold build takes 1-3s and the tick is 2s,
// so on any page where the first build is the slower one the loop never terminates:
//
//   • the panel stays on "Loading tape from X…" forever, because status is only ever set to 'ready'
//     or 'error' at the END of a build that is allowed to finish;
//   • the retry backoff (3s, 8s, 20s) is wiped by the same cleanup, so the attempts never exhaust
//     and the "X is rate-limiting" fallback link never appears either;
//   • every restart spends another syndication request, so X 429s the visitor's IP within seconds,
//     after which no build can succeed and the loop sustains itself for the rest of the session.
//
// Run: node scripts/verify-xtape-lifecycle.mjs

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } };

// ── the component's real constants ───────────────────────────────────────────
const RETRY_DELAYS = [3000, 8000, 20000];
const MIN_REBUILD_MS = 20 * 1000;
const TIMER_REFRESH_MS = 60 * 1000;
const IDLE_REBUILD_MS = 10 * 60 * 1000;
const HIDDEN_REFRESH_MS = 30 * 60 * 1000;
const HOVER_MAX_HOLD_MS = 3 * 60 * 1000;
const TICK_MS = 2000;
const BUILD_STALL_MS = 90 * 1000;

// X's syndication limit is per visitor IP. These numbers only have to be the right SHAPE: a handful
// of rebuilds in quick succession gets refused, and a refusal is silent.
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 5;

// The clock is a real wall-clock value, because that is exactly what made the zero seed a bug.
const MOUNT = 1_700_000_000_000;

/**
 * @param fixed        true = shipped behaviour (mount-time seed + in-flight guard)
 * @param buildMs      how long one build takes end to end (widgets.js, createTimeline, paint)
 * @param heads        [{ at, id }] head-signal changes, absolute ms from mount; [] = no signal
 * @param hidden       the tab is backgrounded for the whole run
 * @param hoverFrom    ms from mount at which the cursor lands on the tape and never leaves
 * @param stall        true = the build never settles, to prove the scheduler cannot latch forever
 */
function run({ fixed, buildMs = 2500, heads = [], hidden = false, hoverFrom = null,
  stall = false, horizon = 5 * 60 * 1000, rateLimited = true } = {}) {
  let now = MOUNT;
  const timers = [];
  const at = (delay, fn) => { const t = { at: now + delay, fn, live: true }; timers.push(t); return t; };
  const clear = (t) => { if (t) t.live = false; };

  // build effect state
  let builtAt = fixed ? MOUNT : 0;          // THE SEED
  let builtHead;
  let building = false, buildSince = 0;
  let status = 'loading';
  let seq = 0;                              // a new build invalidates the previous one's callbacks
  let retryTimer = null;
  let head = null;

  const requests = [];                      // one per syndication fetch, for the rate limiter
  const restarts = [];                      // builds cancelled before they could finish
  let readyAt = null;

  const inFlightGuard = () => fixed && building && now - buildSince < BUILD_STALL_MS;
  const hoverAt = hoverFrom === null ? null : MOUNT + hoverFrom;
  const held = () => hoverAt !== null && now >= hoverAt && now - hoverAt < HOVER_MAX_HOLD_MS;

  const shouldBuild = () => {
    const since = now - builtAt;
    if (hidden) return since >= HIDDEN_REFRESH_MS;
    if (since >= IDLE_REBUILD_MS) return true;
    if (!head?.id) return since >= TIMER_REFRESH_MS;
    return head.id !== builtHead && since >= MIN_REBUILD_MS;
  };

  const attempt = (mySeq, i) => {
    if (mySeq !== seq) return;
    requests.push(now);
    const refused = rateLimited && requests.filter((t) => now - t < RL_WINDOW_MS).length > RL_MAX;
    if (stall) return;                                  // never settles, on purpose
    at(refused ? 800 : buildMs, () => {
      if (mySeq !== seq) return;
      if (!refused) {
        builtAt = now; building = false; status = 'ready';
        if (readyAt === null) readyAt = now - MOUNT;
        return;
      }
      if (i < RETRY_DELAYS.length) { retryTimer = at(RETRY_DELAYS[i], () => attempt(mySeq, i + 1)); return; }
      builtHead = undefined;
      building = false;
      if (fixed) builtAt = now;                         // stop retrying on the very next tick
      status = status === 'ready' ? 'ready' : 'error';
    });
  };

  const startBuild = () => {
    if (building) restarts.push(now - MOUNT);           // cleanup cancels whatever was in flight
    clear(retryTimer);
    seq++;
    building = true; buildSince = now;
    builtHead = head?.id;
    attempt(seq, 0);
  };

  // A head change dated at or before mount is one the poller already had in hand, so the first build
  // is anchored to it. That is the difference between "the tape caught up 20s later" and "the tape
  // was right the first time", and both are worth testing separately.
  for (const h of heads) if (h.at <= 0) { head = { id: h.id }; h.applied = true; }
  startBuild();                                          // the mount build
  const tick = () => {
    if (!held() && !inFlightGuard() && shouldBuild()) startBuild();
    at(TICK_MS, tick);
  };
  at(TICK_MS, tick);

  // advance the clock, firing timers in order
  const end = MOUNT + horizon;
  for (;;) {
    for (const h of heads) if (h.at + MOUNT <= now && head?.id !== h.id && h.applied !== true) { head = { id: h.id }; h.applied = true; }
    const due = timers.filter((t) => t.live && t.at <= now);
    if (due.length) { for (const t of due) { t.live = false; t.fn(); } continue; }
    const next = timers.filter((t) => t.live).map((t) => t.at).sort((a, b) => a - b)[0];
    const headNext = heads.filter((h) => !h.applied).map((h) => h.at + MOUNT).sort((a, b) => a - b)[0];
    const step = Math.min(next ?? Infinity, headNext ?? Infinity);
    if (!Number.isFinite(step) || step > end) break;
    now = step;
  }
  for (const h of heads) delete h.applied;
  return {
    status, readyAt, restarts: restarts.length, builds: seq,
    requestsFirstMinute: requests.filter((t) => t - MOUNT < 60_000).length,
    requests: requests.length,
  };
}

console.log('\n=== THE BUG: a first build slower than one 2s tick ===');
const slowBroken = run({ fixed: false, buildMs: 2500 });
ok('the old scheduler never lets a 2.5s first build finish', slowBroken.readyAt === null,
  `reached ready at ${slowBroken.readyAt}ms`);
ok('...and never reaches the error fallback either, so the panel just says Loading',
  slowBroken.status === 'loading', `status was ${slowBroken.status}`);
ok('...while spending syndication requests far past the rate limit',
  slowBroken.requestsFirstMinute > RL_MAX, `${slowBroken.requestsFirstMinute} in the first minute`);
console.log(`  old: status=${slowBroken.status} restarts=${slowBroken.restarts} requests=${slowBroken.requests} (first minute: ${slowBroken.requestsFirstMinute})`);

const slowFixed = run({ fixed: true, buildMs: 2500 });
ok('the fix lets that same build finish', slowFixed.status === 'ready' && slowFixed.readyAt === 2500,
  `status=${slowFixed.status} readyAt=${slowFixed.readyAt}`);
ok('...without a single cancelled build', slowFixed.restarts === 0, `${slowFixed.restarts} restarts`);
ok('...on ONE syndication request in the first minute', slowFixed.requestsFirstMinute === 1,
  `${slowFixed.requestsFirstMinute}`);
console.log(`  fixed: status=${slowFixed.status} ready at ${slowFixed.readyAt}ms requests=${slowFixed.requests} (first minute: ${slowFixed.requestsFirstMinute})`);

console.log('\n=== the same failure on any LATER refresh, not just the first ===');
// Head moves at 30s, so a refresh is due; the rebuild takes 3s, longer than a tick.
const heads = () => [{ at: 30_000, id: 'b' }];
const refreshBroken = run({ fixed: false, buildMs: 3000, heads: heads(), horizon: 120_000 });
const refreshFixed = run({ fixed: true, buildMs: 3000, heads: heads(), horizon: 120_000 });
ok('a slow REBUILD used to be restarted too', refreshBroken.restarts > 0, 'nothing was cancelled');
ok('the fix never restarts an in-flight rebuild', refreshFixed.restarts === 0,
  `${refreshFixed.restarts} restarts`);
console.log(`  old restarts=${refreshBroken.restarts} requests=${refreshBroken.requests} | fixed restarts=${refreshFixed.restarts} requests=${refreshFixed.requests}`);

console.log('\n=== everything the fix had to preserve ===');
const fast = run({ fixed: true, buildMs: 900, horizon: 130_000 });
ok('with no head signal the tape still refreshes on the 60s timer', fast.builds === 3,
  `${fast.builds} builds in 130s`);

const moved = run({ fixed: true, buildMs: 900, heads: [{ at: 30_000, id: 'b' }], horizon: 60_000 });
ok('a moved head still triggers a rebuild', moved.builds === 2, `${moved.builds} builds`);
const movedEarly = run({ fixed: true, buildMs: 900, heads: [{ at: 4_000, id: 'b' }], horizon: 18_000 });
ok('...but never inside the 20s floor between two syndication requests', movedEarly.builds === 1,
  `${movedEarly.builds} builds in 18s`);

const quiet = run({ fixed: true, buildMs: 900, heads: [{ at: 0, id: 'a' }], horizon: 9 * 60 * 1000 });
ok('a quiet list is not rebuilt on a blind timer', quiet.builds === 1, `${quiet.builds} builds in 9min`);
const idle = run({ fixed: true, buildMs: 900, heads: [{ at: 0, id: 'a' }], horizon: 11 * 60 * 1000 });
ok('...but the 10-minute safety net still fires', idle.builds === 2, `${idle.builds} builds in 11min`);
// The head arriving a moment AFTER the first build is anchored is the ordinary page load: the poller
// and the build start together. The tape then catches up once, on the 20s floor, and goes quiet.
const catchUp = run({ fixed: true, buildMs: 900, heads: [{ at: 1_000, id: 'a' }], horizon: 9 * 60 * 1000 });
ok('a head that lands mid-build produces exactly one catch-up rebuild', catchUp.builds === 2,
  `${catchUp.builds} builds in 9min`);

const hovered = run({ fixed: true, buildMs: 900, hoverFrom: 5_000, horizon: 130_000 });
ok('the cursor on the tape still holds refreshes off', hovered.builds === 1, `${hovered.builds} builds`);
const hoverCap = run({ fixed: true, buildMs: 900, hoverFrom: 5_000, horizon: 5 * 60 * 1000 });
ok('...and that hold is still time-capped', hoverCap.builds > 1, 'hover latched permanently');

const bg = run({ fixed: true, buildMs: 900, hidden: true, horizon: 25 * 60 * 1000 });
ok('a backgrounded tab still stops spending requests', bg.builds === 1, `${bg.builds} builds in 25min`);
const bgLong = run({ fixed: true, buildMs: 900, hidden: true, horizon: 35 * 60 * 1000 });
ok('...and still wakes on the 30-minute cadence', bgLong.builds === 2, `${bgLong.builds} builds in 35min`);

const limited = run({ fixed: true, buildMs: 900, rateLimited: true, horizon: 10 * 60 * 1000 });
ok('the retry backoff survives (it is no longer wiped by a tick)', limited.status === 'ready');

const stalled = run({ fixed: true, stall: true, horizon: 4 * 60 * 1000 });
ok('a build that never settles cannot freeze the tape forever', stalled.builds > 1,
  'the in-flight guard latched on permanently');
console.log(`  stalled build: ${stalled.builds} builds attempted over 4min (guard releases at ${BUILD_STALL_MS / 1000}s)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
