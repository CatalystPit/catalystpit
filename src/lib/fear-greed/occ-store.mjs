// OPTIONS VOLUME — the durable record of what OCC actually published.
//
// ⚠️ ONE ROW PER MARKET SESSION, WRITTEN ONCE, NEVER REFETCHED. A published session's cleared
// volume is immutable, so normal daily operation asks OCC only for sessions it does not already
// hold. That is what keeps a 500-session normalisation window off the wire every night.
//
// ⚠️ AND EVERY ROW CARRIES ITS PROVENANCE. session date, actual put volume, actual call volume,
// the number of exchanges that summed to it, when we retrieved it and which endpoint said so.
// The put/call ratio is DERIVED from the stored actuals at read time rather than stored, so there
// is no path by which a ratio can exist without the two volumes that produce it.

import { sql } from 'drizzle-orm';
import { db } from '../db';
import { fetchEquityVolume, OCC_SOURCE } from './occ.mjs';

const rows = (res) => res?.rows ?? res ?? [];

let _ensured = false;
export async function ensureOptionsTable(dbc = db) {
  if (_ensured) return;
  await dbc.execute(sql`CREATE TABLE IF NOT EXISTS occ_options_volume (
    session_date DATE PRIMARY KEY,
    calls        BIGINT NOT NULL,
    puts         BIGINT NOT NULL,
    volume       BIGINT NOT NULL,
    exchanges    INTEGER NOT NULL,
    source       TEXT NOT NULL,
    retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // ⚠️ A ROW THAT CANNOT PRODUCE A RATIO MUST NOT EXIST. calls > 0 is the division's own
  // precondition, enforced by the database rather than by whoever writes next.
  await dbc.execute(sql`DO $$ BEGIN
    ALTER TABLE occ_options_volume ADD CONSTRAINT occ_options_volume_calls_positive CHECK (calls > 0);
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  _ensured = true;
}

/** Session dates already stored, so ingestion never asks OCC for them again. */
export async function storedSessions(dbc = db, { since = null } = {}) {
  await ensureOptionsTable(dbc);
  const res = await dbc.execute(since
    ? sql`select session_date::text as d from occ_options_volume where session_date >= ${since}::date`
    : sql`select session_date::text as d from occ_options_volume`);
  return new Set(rows(res).map((r) => String(r.d)));
}

/** The stored observations, oldest first. The ratio is computed here, from the actuals. */
export async function loadOptionsVolume(dbc = db, { sinceDays = 2600 } = {}) {
  await ensureOptionsTable(dbc);
  const res = await dbc.execute(sql`
    select session_date::text as date, calls::bigint as calls, puts::bigint as puts
      from occ_options_volume
     where session_date >= (current_date - make_interval(days => ${sinceDays}))
     order by session_date asc`);
  return rows(res).map((r) => ({ date: String(r.date), calls: Number(r.calls), puts: Number(r.puts) }));
}

/**
 * Fetch and store any of `dates` we do not already hold.
 *
 * ⚠️ BOUNDED AND FAIL-CLOSED. `limit` caps a single run, a session OCC has not published is simply
 * not written, and a failed fetch writes nothing at all — the component is then missing for that
 * session and the index's existing rule handles it. Nothing is invented to fill a gap.
 */
export async function ingestSessions(dates, {
  dbc = db, limit = 400, concurrency = 6, gapMs = 150, onProgress = null,
} = {}) {
  await ensureOptionsTable(dbc);
  const have = await storedSessions(dbc);
  const todo = dates.map(String).filter((d) => !have.has(d)).slice(0, limit);
  const stat = { asked: todo.length, stored: 0, unpublished: 0, failed: 0 };

  for (let i = 0; i < todo.length; i += concurrency) {
    const batch = todo.slice(i, i + concurrency);
    const got = await Promise.all(batch.map(async (d) => {
      try { return await fetchEquityVolume(d); } catch { return undefined; }
    }));
    for (const obs of got) {
      if (obs === undefined) { stat.failed++; continue; }
      if (obs === null) { stat.unpublished++; continue; }
      await dbc.execute(sql`
        insert into occ_options_volume (session_date, calls, puts, volume, exchanges, source, retrieved_at)
        values (${obs.date}, ${obs.calls}, ${obs.puts}, ${obs.volume}, ${obs.exchanges},
                ${obs.source}, ${obs.retrievedAt})
        on conflict (session_date) do nothing`);
      stat.stored++;
    }
    if (onProgress) onProgress({ ...stat, done: Math.min(i + concurrency, todo.length) });
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  return stat;
}

export { OCC_SOURCE };
