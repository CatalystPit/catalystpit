// ⚠️ IS THE PERCENTAGE REAL, OR A CLOSE COMPARED AGAINST ITSELF?
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-eod-change.mjs
//
// ── THE BUG ──────────────────────────────────────────────────────────────────────────────────────
//
// getQuotes() serves prevClose as the price to anyone without a real-time entitlement — correct, and
// the entire point of the licensing gate. The change percentage was then computed as
// (price - prevClose) / prevClose, which with price === prevClose is exactly 0. Every ticker on the
// homepage Market Snapshot and every watchlist row read 0.00% on days the market moved percent.
//
// Three independent places then turned "unknown" into a hard zero, and fixing any one alone would
// have changed nothing on the page:
//   tiingo.mjs   (price - prevClose) / prevClose  with price === prevClose
//   refresh route  `: 0` on both the change and the percentage
//   CatalystPit.jsx  safeN(...) returns 0 for anything unparseable
//
// So these assertions are about REAL STORED SESSIONS, not about shapes.

import { lastSessionChange } from '../src/lib/market/eod-change.mjs';
import { maybeN } from '../src/lib/num.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); }
};
const L = (s) => console.log(`\n${s}`);
const code = (p) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const HOMEPAGE = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'GOOGL', 'AMD', 'SPY', 'QQQ', 'DIA', 'UVXY'];

L('⚠️ 1 — the real last-session return, from stored consecutive sessions');
const got = await lastSessionChange(HOMEPAGE);
{
  ok(`⚠️ a return is produced for the homepage tickers (${got.size}/${HOMEPAGE.length})`,
    got.size >= 8, [...got.keys()].join(','));

  const sessions = new Set([...got.values()].map((v) => `${v.prevSession}→${v.session}`));
  // ⚠️ ONE PAIR OF DATES FOR EVERY SYMBOL. Per-symbol "two most recent bars" would compare a halted
  // name's September close against its August one and print it beside today's movers.
  ok('⚠️ every figure describes the SAME two sessions', sessions.size === 1,
    [...sessions].join(' | '));

  console.log(`\n      session: ${[...sessions][0] || '(none)'}`);
  for (const t of HOMEPAGE) {
    const v = got.get(t);
    if (!v) { console.log(`      ${t.padEnd(6)} (no stored pair)`); continue; }
    const pct = v.changePct;
    console.log(`      ${t.padEnd(6)} ${String(v.prevClose).padStart(9)} → ${String(v.close).padStart(9)}  `
      + `${(pct >= 0 ? '+' : '') + pct.toFixed(2)}%`);
  }
}

L('⚠️ 2 — the figures are arithmetically what the stored closes say');
{
  let checked = 0;
  for (const [sym, v] of got) {
    const expected = ((v.close - v.prevClose) / v.prevClose) * 100;
    if (Math.abs(expected - v.changePct) > 1e-9) {
      ok(`${sym} percentage matches its own closes`, false, `${v.changePct} vs ${expected}`);
    } else checked++;
  }
  ok(`⚠️ all ${checked} returns equal (close - prior) / prior`, checked === got.size);
  // ⚠️ AND NOT EVERY ONE IS ZERO. That is the regression this whole suite exists for: if the
  // comparison ever goes back to close-against-itself, every value becomes 0 and only this catches it.
  const nonZero = [...got.values()].filter((v) => Math.abs(v.changePct) > 0.0001).length;
  ok(`⚠️ the returns are NOT all zero (${nonZero}/${got.size} moved)`, nonZero >= Math.max(1, got.size - 2),
    'a board of 0.00% is the defect, not a quiet day');
  const signs = new Set([...got.values()].map((v) => (v.changePct > 0 ? '+' : v.changePct < 0 ? '-' : '0')));
  console.log(`      signs present: ${[...signs].join(' ')}`);
}

L('⚠️ 3 — unknown is null everywhere, never zero');
{
  // Executed, not read: this is the helper the homepage uses.
  ok('⚠️ maybeN(null) is null, not 0', maybeN(null) === null);
  ok('⚠️ maybeN(undefined) is null', maybeN(undefined) === null);
  ok('⚠️ maybeN("") is null', maybeN('') === null);
  ok('⚠️ …but maybeN(0) is 0, because flat is a real outcome', maybeN(0) === 0);
  ok('⚠️ …and maybeN("-1.25") still parses', maybeN('-1.25') === -1.25);
  // The old helper is kept for widths and counts, where 0 is the right answer.
  // safeN is deliberately LEFT ALONE: widths, counts and sort keys genuinely want 0 for missing
  // input, and changing it would have rippled through every caller to fix two of them.
  ok('safeN still coerces unparseable input to 0, for the callers that want that',
    /isNaN\(x\) \? 0 : x/.test(code('src/lib/cp-shared.jsx')));

  const page = code('src/components/CatalystPit.jsx');
  ok('⚠️ the homepage tape no longer flattens a missing change to zero',
    /chg: maybeN\(/.test(page) && !/chg: safeN\(/.test(page));
  // ⚠️ AND THE FABRICATED MARKET MOVE IS GONE. A missing SPY change fell back to the literal 1.2 —
  // a plausible-looking percentage presented as the market's actual return.
  ok('⚠️ SPY no longer falls back to a made-up 1.2%',
    !/change_pct \?\? 1\.2/.test(page) && /spy_chg = maybeN\(/.test(page));

  const refresh = code('src/app/api/refresh/route.js');
  // ⚠️ ASSERTED AS A POSITIVE, NOT AS THE ABSENCE OF ONE OLD STRING. The first version checked that
  // the previous `: 0` expression was gone, and mutation testing walked straight past it by writing
  // a DIFFERENT zero fallback. What matters is what the fallback IS.
  ok('⚠️ the snapshot route falls back to the real session return, not to zero',
    /: \(session \? session\.changePct : null\)/.test(refresh)
    && /: \(session \? session\.close - session\.prevClose : null\)/.test(refresh));
  ok('⚠️ …and no `: 0` fallback survives on the change fields',
    !/change(Pct)?:[^\n]*: 0[,\s]/.test(refresh));
  ok('⚠️ …and it actually calls lastSessionChange, not merely imports it',
    /await lastSessionChange\(/.test(refresh));
  // ⚠️ THE Number(null) TRAP, ASSERTED DIRECTLY, BECAUSE I FELL INTO IT WRITING THIS FIX.
  //
  // Number(null) is 0 and Number.isFinite(0) is true, so `Number.isFinite(Number(q.changePct))`
  // answers TRUE for a quote that correctly reported null — and the route then published 0 as an
  // intraday figure. It was in KV, stamped basis "intraday", while the provider underneath was
  // returning null exactly as designed. parseFloat(null) is NaN, which is why maybeN is the one to
  // reach for. Nothing on this path may coerce the change fields with Number().
  ok('⚠️ the change fields are parsed with maybeN, never Number()',
    /const live = maybeN\(q\?\.changePct\)/.test(refresh)
    && !/Number\(q\?\.changePct\)/.test(refresh),
    'Number(null) === 0 and would publish a zero as an intraday change');
  const watchEarly = code('src/app/api/watchlist/route.js');
  ok('⚠️ …and the watchlist does the same',
    /maybeN\(q\.dp\)/.test(watchEarly) && !/Number\.isFinite\(Number\(q\.dp\)\)/.test(watchEarly));
  ok('⚠️ …and says which session the percentage describes',
    /changeBasis/.test(refresh) && /last_session/.test(refresh));

  const tiingo = code('src/lib/market/tiingo.mjs');
  // ⚠️ GATED ON REALTIME FRESHNESS, NOT ON priceIsLive. priceIsLive is true whenever the vendor is
  // NOT live (useLivePrice is `!(vendorIsLive && !entitled)`), which is every closed market — so
  // gating on it left the zero exactly where it was. Measured in KV after that deploy: changePct 0
  // on every entry, stamped basis "intraday". REALTIME means the vendor is live AND we may serve it,
  // which is the only state in which `price` is an intraday price at all.
  ok('⚠️ the provider reports an intraday change only when an intraday price was served',
    /const changePct = \(gate\.freshness === FRESHNESS\.REALTIME && prevClose != null/.test(tiingo),
    'priceIsLive is true for a settled close and is not the right test');

  const watch = code('src/app/api/watchlist/route.js');
  ok('⚠️ the watchlist no longer recomputes a close against itself',
    !/\(pc > 0 \? \+\(\(\(c - pc\) \/ pc\) \* 100\)\.toFixed\(4\) : null\)/.test(watch));
  ok('⚠️ …and its quote cache key is versioned, so stored zeros are unreachable',
    /:quote:v2/.test(watch), 'a cached dp:0 is finite and would win over the real figure');
  // ⚠️ AND IT ATTACHES THE REAL FIGURE. Removing the old recompute only guarantees the watchlist
  // stops lying; it does not guarantee it starts telling the truth. Mutation testing found exactly
  // that gap — deleting the call left every row at a dash, and every assertion still passed.
  ok('⚠️ …and it actually calls lastSessionChange for the whole list',
    /await lastSessionChange\(tickers\)/.test(watch));
  ok('⚠️ …and prefers an intraday figure only when one genuinely exists',
    /const live = q \? maybeN\(q\.dp\) : null;/.test(watch)
    && /live != null \? live : \(session \? \+session\.changePct\.toFixed\(4\) : null\)/.test(watch));
}

L('⚠️ 4 — licensing is unchanged');
{
  const mod = code('src/lib/market/eod-change.mjs');
  ok('⚠️ it reads licensed candle sources only',
    /LICENSED_CANDLE_SOURCES_SQL/.test(mod) && /source = any/.test(mod));
  ok('⚠️ …and adds no provider', !/fetch\(/.test(mod) && !/tiingo\(/.test(mod));
  // ⚠️ THE CALL, NOT THE IMPORT. The first version matched /pickSessionDates/, which the import line
  // satisfies all by itself — so deleting the actual call and taking the two newest dates instead
  // survived the mutation. Today that happens to give the same answer, because the weekend bars were
  // cleared; the next weekend straggler would make it wrong, silently.
  ok('⚠️ …and reuses the market-session quorum rule, so a weekend bar is not a session',
    /=\s*pickSessionDates\(/.test(mod), 'the rule must be invoked, not just imported');
  ok('⚠️ a symbol missing either close is ABSENT, not zero',
    /if \(close == null \|\| prior == null \|\| prior <= 0\) continue;/.test(mod));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
