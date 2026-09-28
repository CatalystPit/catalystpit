// QUALIFYING EVENTS, RESOLVED ONCE WHEN THEY ARRIVE.
//
// ⚠️ THE ARCHITECTURAL FAULT THIS REPLACES.
//
// The badge used to answer every request by re-deriving everything. Measured on the 100 largest US
// issuers: candidate nomination cost 188ms for ONE query, materiality and dedupe cost 0ms,
// serialisation cost 0ms — and `tickerEvidence` cost ~1,350ms and SEVEN database queries PER
// TICKER. Sixty names is ~420 queries and twenty-two seconds, for every user, every sixty seconds,
// to compute an answer that does not depend on the user at all.
//
// That cost is why a cap existed, and the cap is a correctness bug: 21 nominated securities were
// not resolved and were reported to the user as "nothing happened". Raising the cap moves the
// failure; removing the work removes it.
//
// So the expensive half runs ONCE PER EVENT, here, and writes canonical rows. The read path becomes
// one indexed query over those rows with no per-ticker work, no cap and nothing to truncate.
//
// ⚠️ IT IS THE SAME ENGINE AND THE SAME CONTRACT. This file resolves nothing itself: it calls
// tickerEvidence and watchlist-new's eligibleForNew/countNew, exactly as the read path used to.
// A second classifier here would be a second opinion that drifts, which is the failure the Evidence
// Engine exists to prevent.
import { sql } from 'drizzle-orm';
import { db } from './db';
import { tickerEvidence } from './evidence/resolve';
import { countNew } from './watchlist-new.mjs';
import { isIngestableTicker } from './security-identity.mjs';
import { ISSUER_WIRE, NEWS_DESK } from './evidence/company-events.mjs';

let _ensured = false;
export async function ensureTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS watchlist_events (
    id BIGSERIAL PRIMARY KEY,
    event_key TEXT NOT NULL,
    ticker TEXT NOT NULL,
    family TEXT NOT NULL,
    event_type TEXT NOT NULL,
    materiality REAL NOT NULL,
    public_time TIMESTAMPTZ NOT NULL,
    summary TEXT,
    url TEXT,
    reference_period TEXT,
    built_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // ⚠️ THE EVENT KEY IS THE DEDUPE. One real-world event is one row however many outlets carried
  // it, because the key is (ticker, event class, day) — see newEventKey. The uniqueness is enforced
  // by the database rather than by whoever happens to be counting.
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_watchlist_events_key ON watchlist_events (event_key)`);
  // The read pattern, exactly: "these tickers, newer than this watermark, newest first."
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_watchlist_events_read ON watchlist_events (ticker, public_time DESC)`);
  // Retention sweeps and the builder's own bookkeeping read this one.
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_watchlist_events_time ON watchlist_events (public_time DESC)`);

  // ⚠️ COVERAGE IS A STORED FACT, because "checked and nothing happened" and "not checked" are
  // different answers and the API must never turn the second into the first.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS watchlist_events_state (
    id INT PRIMARY KEY DEFAULT 1,
    built_through TIMESTAMPTZ,
    built_at TIMESTAMPTZ,
    last_error TEXT,
    CONSTRAINT watchlist_events_state_single CHECK (id = 1)
  )`);
  // ⚠️ PARTIAL PROGRESS HAS TO BE DURABLE, or a bound on one run becomes an infinite loop over the
  // same first N tickers — which is exactly what happened: 726 changed names, 400 processed per
  // run, and thirteen runs that each did the identical 400 because the time cursor could not move
  // until the batch was complete. The resume marker is what makes a capped run make progress.
  await db.execute(sql`ALTER TABLE watchlist_events_state ADD COLUMN IF NOT EXISTS resume_after TEXT`);
  _ensured = true;
}

const rows = (res) => res?.rows ?? res ?? [];

/**
 * Every ticker with a source row that became public at or after `since` — the WHOLE universe, not
 * one user's list. Same five branches and same clocks as the read-side prefilter.
 */
export async function changedTickersSince(since) {
  const sinceIso = new Date(since).toISOString();
  const sinceDay = sinceIso.slice(0, 10);
  const sources = sql.join([...ISSUER_WIRE, ...NEWS_DESK].map((s) => sql`${s}`), sql`, `);
  const res = await db.execute(sql`
    select distinct ticker from (
      select upper(ticker) as ticker from insider_trades where filing_date >= ${sinceDay}::date
      union all
      select upper(ticker) from eightk_filings where filed_at >= ${sinceIso}::timestamptz
      union all
      select upper(ticker) from congress_trades where disclosure_date >= ${sinceDay}::date
      union all
      select upper(h.ticker) from fund_holdings h
        join fund_filings f on f.cik = h.cik and f.quarter = h.quarter
        where f.filed_date >= ${sinceDay}::date
      union all
      select upper(t) from primary_events, unnest(tickers) as t
        where published_at >= ${sinceIso}::timestamptz and upper(source) in (${sources})
    ) s`);
  return rows(res).map((r) => String(r.ticker).toUpperCase()).filter(isIngestableTicker);
}

async function pooled(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn)));
  return out;
}

/** The builder's own clock: how far the materialised view has been brought up to date. */
export async function coverage() {
  await ensureTables();
  const r = rows(await db.execute(sql`select built_through, built_at, last_error, resume_after from watchlist_events_state where id = 1`));
  const s = r[0] || {};
  return {
    builtThrough: s.built_through ? new Date(s.built_through).toISOString() : null,
    builtAt: s.built_at ? new Date(s.built_at).toISOString() : null,
    lastError: s.last_error || null,
    resumeAfter: s.resume_after || null,
  };
}

/**
 * Bring the materialised view up to date.
 *
 * @param lookbackMs how far back to look for changed tickers when there is no cursor yet
 * @param overlapMs  re-examine a little before the cursor, because a filing can land with a
 *                   publication time slightly behind the moment we noticed it
 * @param maxTickers a safety bound on ONE run, not on coverage: whatever is left is picked up by
 *                   the next run because the cursor only advances over what was actually processed
 */
export async function buildWatchlistEvents({
  now = Date.now(), lookbackMs = 3 * 86_400_000, overlapMs = 15 * 60_000,
  maxTickers = 400, concurrency = 6,
} = {}) {
  await ensureTables();
  const state = await coverage();
  const cursor = state.builtThrough ? Date.parse(state.builtThrough) : now - lookbackMs;
  const from = new Date(Math.max(0, cursor - overlapMs)).toISOString();

  // Sorted, so "everything after the last name I finished" is a stable, resumable position.
  const changed = (await changedTickersSince(from)).sort();
  const resumeAfter = state.resumeAfter;
  const pending = resumeAfter ? changed.filter((t) => t > resumeAfter) : changed;
  const batch = pending.slice(0, maxTickers);
  // ⚠️ THE CURSOR ONLY MOVES OVER WHAT WAS PROCESSED. If the batch was capped, the next run picks
  // up after the last name finished and completes the sweep — a bound on one run must never become
  // a gap, and it must never become a treadmill either.
  const complete = batch.length === pending.length;

  let written = 0, failed = 0;
  const errors = [];
  await pooled(batch, concurrency, async (ticker) => {
    try {
      const r = await tickerEvidence(ticker, { now, since: new Date(now - 45 * 86_400_000).toISOString() });
      const { events } = countNew(r.evidence, { now });
      for (const e of events) {
        await db.execute(sql`
          insert into watchlist_events
            (event_key, ticker, family, event_type, materiality, public_time, summary, url, reference_period, built_at)
          values (${eventKeyOf(e)}, ${e.ticker}, ${e.family}, ${e.type}, ${Number(e.materiality)},
                  ${new Date(e.publicTime).toISOString()}::timestamptz, ${e.summary ?? null}, ${e.url ?? null},
                  ${e.referencePeriod ? String(e.referencePeriod) : null}, now())
          on conflict (event_key) do update set
            -- The most material shape of one event wins, which is what countNew chose in memory.
            event_type = excluded.event_type, materiality = excluded.materiality,
            summary = excluded.summary, url = excluded.url, built_at = now()
          where watchlist_events.materiality < excluded.materiality`);
        written += 1;
      }
    } catch (e) {
      failed += 1;
      if (errors.length < 5) errors.push(`${ticker}: ${String(e?.message || e).slice(0, 120)}`);
    }
  });

  // ⚠️ THE CURSOR DOES NOT ADVANCE PAST A FAILURE. A ticker that threw has not been materialised,
  // and moving the clock over it would turn a transient error into a permanent hole.
  const advance = failed === 0 && complete;
  // Where the next run resumes: nowhere when the sweep finished, otherwise after the last name in
  // this batch. A failure leaves both clocks where they were, so nothing is skipped.
  const nextResume = advance ? null : (batch.length ? batch[batch.length - 1] : resumeAfter ?? null);
  await db.execute(sql`
    insert into watchlist_events_state (id, built_through, built_at, last_error, resume_after)
    values (1, ${advance ? new Date(now).toISOString() : (state.builtThrough ?? new Date(cursor).toISOString())}::timestamptz,
            now(), ${errors.length ? errors.join(' | ') : null}, ${nextResume})
    on conflict (id) do update set
      built_through = excluded.built_through, built_at = excluded.built_at,
      last_error = excluded.last_error, resume_after = excluded.resume_after`);

  return { changed: changed.length, pending: pending.length, processed: batch.length, written, failed, complete, errors };
}

// Kept local so the insert and the in-memory counter cannot drift: both derive the key the same way.
import { newEventKey } from './watchlist-new.mjs';
const eventKeyOf = (e) => newEventKey(e);
