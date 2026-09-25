// FEAR & GREED — materialisation.
//
// ── ⚠️ A VIEWER NEVER COMPUTES THE INDEX ────────────────────────────────────
//
// The full calculation loads ~1,000 tickers of daily history and takes about 40 seconds. A hundred
// people opening the page must read one stored answer, not start a hundred of those. So the cron
// computes, Postgres keeps the durable history, and KV holds the finished payload the API serves.
//
// Two stores rather than one, on purpose:
//
//   fear_greed_daily   the record. Survives a KV flush, and is what a future backfill reconciles
//                      against. One row per session.
//   KV payload         the read path. One GET, already shaped for the card.
//
// KV is a cache of the record, never the record itself — if it is empty the API rebuilds the
// payload from Postgres rather than recomputing anything.

import { sql } from 'drizzle-orm';
import { db } from '../db';
import { kvGetJson, kvSetJson, kvConfigured } from '../consensus/materialization.mjs';
import { METHODOLOGY, COMPONENTS, zoneFor } from './model.mjs';

const rows = (res) => res?.rows ?? res ?? [];

/** Version is in the key, so a methodology change cannot serve stale numbers under new rules. */
export const PAYLOAD_KEY = `fear-greed:payload:${METHODOLOGY.version}`;
/** A day is generous: the cron writes daily and a stale payload is better than none. */
export const PAYLOAD_TTL_SEC = 36 * 3600;

let _ensured = false;
export async function ensureTable() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS fear_greed_daily (
    date DATE NOT NULL,
    version TEXT NOT NULL,
    score NUMERIC NOT NULL,
    zone TEXT NOT NULL,
    component_count INTEGER NOT NULL,
    components JSONB NOT NULL,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (date, version)
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_fear_greed_date ON fear_greed_daily (version, date DESC)`);
  _ensured = true;
}

/**
 * ⚠️ HOW MANY RECENT SESSIONS ARE REWRITTEN EVEN IF ALREADY STORED.
 *
 * A past session's score never drifts: it is ranked against the window ENDING at that session, so
 * tomorrow's data cannot change yesterday's percentile. That is what makes the write incremental.
 *
 * The tail is rewritten anyway because the INPUTS can still be corrected — a vendor can restate a
 * close, and a bar can arrive late enough to be missing when the index first ran. Ten sessions is
 * comfortably longer than any correction window we have seen.
 */
export const REWRITE_TAIL = 10;

/**
 * Write the computed history, skipping sessions already stored.
 *
 * ⚠️ UPSERT BY (date, version), so re-running the cron is idempotent and a late-arriving bar can
 * correct a session rather than duplicate it. A row is only ever written for a session the index
 * could actually compute — see indexHistory.
 *
 * ⚠️ AND ONLY WHAT CHANGED. The first run backfills every session it can compute; measured, that is
 * 506 upserts and about 23 seconds. Doing that daily would spend the whole budget rewriting
 * identical rows, so subsequent runs write the new session and the correction tail.
 */
export async function saveHistory(history = []) {
  await ensureTable();
  const known = new Set();
  try {
    const res = await db.execute(sql`
      select date::text as date from fear_greed_daily where version = ${METHODOLOGY.version}`);
    for (const r of rows(res)) known.add(String(r.date));
  } catch { /* an unreadable table means write everything, which is correct if slower */ }

  const tail = new Set(history.slice(-REWRITE_TAIL).map((r) => String(r.date)));
  let written = 0, skipped = 0;
  for (const r of history) {
    if (!r?.available || !Number.isFinite(r.score)) continue;
    if (known.has(String(r.date)) && !tail.has(String(r.date))) { skipped++; continue; }
    const comps = Object.fromEntries(Object.entries(r.components || {})
      .map(([k, c]) => [k, c ? { score: c.score, raw: c.raw, samples: c.samples } : null]));
    try {
      await db.execute(sql`
        insert into fear_greed_daily (date, version, score, zone, component_count, components)
        values (${r.date}, ${METHODOLOGY.version}, ${r.score}, ${r.zone?.label ?? ''},
                ${r.componentCount}, ${JSON.stringify(comps)}::jsonb)
        on conflict (date, version) do update set
          score = excluded.score, zone = excluded.zone,
          component_count = excluded.component_count, components = excluded.components,
          calculated_at = now()`);
      written++;
    } catch { /* one bad session must not lose the rest of the backfill */ }
  }
  return { written, skipped };
}

export async function savePayload(payload) {
  if (!kvConfigured()) return false;
  return kvSetJson(PAYLOAD_KEY, payload, PAYLOAD_TTL_SEC);
}

/** The finished payload, or null. Never computes. */
export async function readPayload() {
  if (!kvConfigured()) return null;
  return kvGetJson(PAYLOAD_KEY);
}

/**
 * Rebuild the payload from the durable history when KV is empty.
 *
 * ⚠️ THIS IS A RESHAPE, NOT A RECALCULATION. Every number comes from rows the cron already wrote;
 * nothing is scored here. The index a viewer sees is always one the cron produced.
 */
export async function payloadFromHistory({ historyLimit = 504 } = {}) {
  await ensureTable();
  const res = await db.execute(sql`
    select date::text as date, score::float8 as score, zone, component_count, components
      from fear_greed_daily
     where version = ${METHODOLOGY.version}
     order by date desc
     limit ${historyLimit}`);
  const desc = rows(res);
  if (!desc.length) return null;
  const asc = [...desc].reverse();
  const current = asc.at(-1);
  const at = (back) => (asc.length > back ? asc[asc.length - 1 - back] : null);
  const strip = (r) => (r ? { date: r.date, score: r.score, zone: r.zone } : null);
  const comps = current.components || {};

  return {
    version: METHODOLOGY.version,
    available: true,
    asOf: current.date,
    score: current.score,
    zone: zoneFor(current.score),
    reason: 'ok',
    componentCount: current.component_count,
    missing: COMPONENTS.filter((m) => !comps[m.key]).map((m) => m.key),
    components: COMPONENTS.map((meta) => {
      const c = comps[meta.key] || null;
      return {
        key: meta.key, label: meta.label,
        score: c?.score ?? null,
        zone: c && Number.isFinite(c.score) ? (zoneFor(c.score)?.label ?? null) : null,
        raw: c?.raw ?? null, samples: c?.samples ?? 0,
        available: Boolean(c), direction: meta.direction, meaning: meta.meaning,
      };
    }),
    comparisons: {
      previousClose: strip(at(1)), weekAgo: strip(at(5)), monthAgo: strip(at(21)),
    },
    history: asc.map((r) => ({ date: r.date, score: r.score })),
    historySessions: asc.length,
    fromHistory: true,
  };
}
