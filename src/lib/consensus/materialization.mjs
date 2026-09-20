// CONSENSUS MATERIALIZATION — how a computed reading becomes something cheap to read.
//
// ── THE DEFECT THIS EXISTS TO FIX ───────────────────────────────────────────
//
// The board lived at one fixed KV key, `consensus:board:v1`, written by a 30-minute cron with
// last-write-wins and a 6-hour TTL. Nothing on the read path looked at what methodology had
// produced those rows — `/api/consensus-board` returned a hardcoded `version: 'consensus_v1'`
// regardless. So when V2.1 deployed, production kept serving V2 rows, described as current, until
// the cron next ran. Two things were wrong and they are different problems:
//
//   FRESHNESS   — a Form 4 landing at 12:01 was invisible until the 12:30 cron.
//   CORRECTNESS — after a methodology change the rows were not merely old, they were computed by
//                 code that no longer exists, and nothing could tell.
//
// ── THE KEY IS THE VERSION CHECK ────────────────────────────────────────────
//
// Rather than stamping a version into the payload and remembering to compare it on every read, the
// materialization version is part of the KEY. A board built under an older methodology physically
// cannot be returned from the current key, because it was written to a different one. There is no
// comparison to forget, and no path where half the board is V2 and half is V2.1 — the whole payload
// is written, or none of it is.
//
// That also gives rollback for free. Deploying an older methodology makes its key live again; the
// newer board is still sitting there, untouched, under its own key.
//
// ── WHAT SCALES WITH WHAT ───────────────────────────────────────────────────
//
// Expensive work scales with EVIDENCE CHANGES and scheduled reconciliation. Reads scale with
// traffic but cost one KV GET. A thousand concurrent visitors read the same materialized bytes;
// they never resolve evidence, and nothing they do can cause a rebuild beyond scheduling one.

import { SYNTHESIS_VERSION } from './synthesis.mjs';
import { METHODOLOGY_VERSION } from './consensus-v1.mjs';
import { SETUP_VERSION } from './setup.mjs';

// ── VERSION ─────────────────────────────────────────────────────────────────
//
// Bump this when the SHAPE of a materialized row changes without the methodology changing — a new
// field the UI depends on, a renamed property. Methodology changes are picked up automatically
// from the two engine versions, which is the case that actually bit us.
export const BOARD_SHAPE_VERSION = 'b3';

/** The fingerprint of the deployed methodology. Any change to it retires every existing key. */
export const MATERIALIZATION_VERSION =
  `${SETUP_VERSION}.${SYNTHESIS_VERSION}.${METHODOLOGY_VERSION}.${BOARD_SHAPE_VERSION}`;

// ── KEYS ────────────────────────────────────────────────────────────────────
export const boardKey = (v = MATERIALIZATION_VERSION) => `consensus:board:${v}`;
export const tickerKey = (ticker, v = MATERIALIZATION_VERSION) =>
  `consensus:ticker:${v}:${String(ticker || '').toUpperCase()}`;
export const dirtyKey = (v = MATERIALIZATION_VERSION) => `consensus:dirty:${v}`;

/**
 * THE LAST KNOWN GOOD BOARD — deliberately NOT version-scoped.
 *
 * One key, overwritten by whichever methodology last built successfully, carrying its own version
 * inside. It exists so a deployment is never an outage: if the new methodology has not built yet,
 * the reader still gets a real board, explicitly labelled as behind. Version-scoping it would
 * defeat the entire point, because after a methodology change there would be nothing in it.
 */
export const LAST_GOOD_KEY = 'consensus:board:last-good';

/** The retired fixed key. Read once on a cold deploy so the first minutes are not a blank page. */
export const LEGACY_BOARD_KEY = 'consensus:board:v1';

// ── TTLs ────────────────────────────────────────────────────────────────────
//
// The board TTL is long on purpose. A board a few hours old is still a truthful account of what was
// filed — disclosure evidence does not move quickly — and is enormously better than a blank page.
// Freshness is the drain's job; the TTL is only a backstop against serving something indefinitely.
export const BOARD_TTL_SEC = 6 * 60 * 60;
export const LAST_GOOD_TTL_SEC = 48 * 60 * 60;
export const TICKER_TTL_SEC = 2 * 60 * 60;
/** How old a materialized ticker may be before a board build recomputes it rather than reusing it. */
export const TICKER_REUSE_MAX_AGE_MS = 30 * 60 * 1000;

// ── DIRTY-SET BOUNDS ────────────────────────────────────────────────────────
//
// A 13F ingest can touch thousands of tickers at once. Recomputing them one at a time would be
// slower and more expensive than simply rebuilding, so past this point targeted work is abandoned
// in favour of one full rebuild. The cap is about which strategy is CHEAPER, not about correctness:
// both paths end with a complete, validated board.
export const DIRTY_TARGETED_CAP = 40;
/** Refuse to let the set grow without bound if the drain is failing. */
export const DIRTY_SET_MAX = 5000;

/** Should this drain recompute the named tickers, or just rebuild everything? Pure. */
export function drainStrategy(dirtyCount, { cap = DIRTY_TARGETED_CAP } = {}) {
  if (!dirtyCount) return 'none';
  return dirtyCount <= cap ? 'targeted' : 'full';
}

// ── KV ──────────────────────────────────────────────────────────────────────
//
// Upstash's generic command endpoint, so set operations do not have to be smuggled through a URL
// path. Every helper FAILS SOFT: consensus materialization is derived data, and it must never be
// able to take down a read path or — far more importantly — an evidence ingest.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const kvConfigured = () => Boolean(KV_URL && KV_TOKEN);

async function command(parts) {
  if (!kvConfigured()) return null;
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parts.map(String)),
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const { result } = await r.json();
    return result ?? null;
  } catch { return null; }
}

export async function kvGetJson(key) {
  const raw = await command(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function kvSetJson(key, value, ttlSec) {
  const parts = ['SET', key, JSON.stringify(value)];
  if (ttlSec) parts.push('EX', ttlSec);
  return (await command(parts)) === 'OK';
}

/** SET NX — the repo's existing single-writer primitive, scoped to consensus rebuilds. */
export async function claimLock(key, ttlSec = 120) {
  // Fails CLOSED, unlike refresh-policy's read-path claim: if we cannot tell whether another
  // rebuild is running, not starting a second one is the safe answer. A missed rebuild is repaired
  // by the next drain; two concurrent rebuilds race on the same keys.
  if (!kvConfigured()) return true;          // no KV means no second instance to race with
  const r = await command(['SET', `lock:${key}`, '1', 'NX', 'EX', ttlSec]);
  return r === 'OK';
}
export const releaseLock = (key) => command(['DEL', `lock:${key}`]);

// ── THE DIRTY SET ───────────────────────────────────────────────────────────

/**
 * MARK TICKERS FOR RECOMPUTATION. Called from evidence ingestion, after the commit.
 *
 * ⚠️ EVIDENCE FIRST, DERIVED CONSENSUS SECOND. This never throws and never rejects. An ingest that
 * rolled back because a derived cache could not be notified would be trading authoritative data for
 * a convenience, and the reconciliation cron exists precisely so that a missed mark is survivable.
 *
 * Dedupe is free: a Redis set holds each ticker once however many filings arrive for it.
 */
export async function markConsensusDirty(tickers) {
  try {
    const list = [...new Set((Array.isArray(tickers) ? tickers : [tickers])
      .map((t) => String(t || '').trim().toUpperCase())
      .filter((t) => /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(t)))];
    if (!list.length || !kvConfigured()) return 0;

    const size = Number(await command(['SCARD', dirtyKey()])) || 0;
    if (size >= DIRTY_SET_MAX) return 0;      // the drain is not keeping up; reconciliation covers it

    await command(['SADD', dirtyKey(), ...list]);
    // The set outlives any single drain but not a stuck one.
    await command(['EXPIRE', dirtyKey(), 24 * 60 * 60]);
    return list.length;
  } catch { return 0; }
}

export async function readDirty() {
  const r = await command(['SMEMBERS', dirtyKey()]);
  return Array.isArray(r) ? r.map(String) : [];
}

/** Clear exactly what was drained. Anything marked DURING the drain survives to the next one. */
export async function clearDirty(members) {
  if (!members?.length) return;
  await command(['SREM', dirtyKey(), ...members]);
}

// ── VALIDATION BEFORE PUBLICATION ───────────────────────────────────────────

/**
 * Is this payload safe to publish as the current board? Pure — no IO, so it is fully testable.
 *
 * The rule that matters: EVERY row must carry the deployed synthesis version. A payload with even
 * one row from another methodology is refused outright rather than published and patched, because
 * "half the board is V2 and half is V2.1" is the exact state this whole design exists to prevent.
 */
export function validateBoardPayload(payload, {
  synthesisVersion = SYNTHESIS_VERSION,
  materializationVersion = MATERIALIZATION_VERSION,
} = {}) {
  const reject = (reason) => ({ ok: false, reason });
  if (!payload || typeof payload !== 'object') return reject('not-an-object');
  if (!Array.isArray(payload.rows)) return reject('no-rows-array');
  if (payload.materializationVersion !== materializationVersion) return reject('version-mismatch');
  if (!payload.builtAt || Number.isNaN(Date.parse(payload.builtAt))) return reject('no-built-at');

  // A board that found nothing is legitimate ONLY when nothing qualified. An empty board with
  // candidates waiting is a failed build, and publishing it would tell every reader that no
  // evidence exists anywhere — a claim about the market rather than about us.
  if (!payload.rows.length) {
    return payload.candidates ? reject('empty-with-candidates') : { ok: true, reason: 'empty' };
  }

  const wrong = payload.rows.filter((r) => r?.canonical?.version !== synthesisVersion);
  if (wrong.length) return reject(`mixed-methodology:${wrong.length}`);
  // V3: the setup layer is versioned too, so a board half-classified by an older archetype set is
  // refused for exactly the same reason a half-V2.1 board was.
  const wrongSetup = payload.rows.filter((r) => r?.setup && r?.version !== SETUP_VERSION);
  if (wrongSetup.length) return reject(`mixed-setup-methodology:${wrongSetup.length}`);
  if (payload.rows.some((r) => !r?.ticker || !r?.canonical?.state)) return reject('malformed-row');

  // More than half the candidates failing is a systemic fault, not a few bad tickers.
  if (payload.candidates && payload.failed > payload.candidates / 2) return reject('too-many-failed');

  return { ok: true, reason: 'valid' };
}

/** How a read should describe what it found. Pure, so the branching is testable without KV. */
export function classifyBoard(payload, { materializationVersion = MATERIALIZATION_VERSION } = {}) {
  if (!payload) return { status: 'degraded', current: false };
  const current = payload.materializationVersion === materializationVersion;
  if (!current) return { status: 'stale-methodology', current: false };
  return { status: payload.rows?.length ? 'ok' : 'empty', current: true };
}
