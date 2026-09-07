import { clerkClient } from '@clerk/nextjs/server';
import { Rest } from 'ably';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { getOrCreateProfile } from './profiles';

// Server-side helpers for The Pit (live chat). Realtime transport = Ably; message history +
// moderation live in Neon (see schema pitMessages/pitReports). Everything degrades gracefully
// when ABLY_API_KEY is unset (chat becomes read-only history) so the site never breaks.

export const PIT_CHANNEL = 'the-pit';
export const MAX_BODY = 500;             // hard cap on a single message
export const RATE_MAX = 10;              // messages allowed…
export const RATE_WINDOW = 60;           // …per this many seconds, per user

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Self-create the Pit tables against whatever DB the app is connected to (mirrors the Institutions
// cron's ensureTables). Makes the feature independent of which Neon branch a migration ran on.
// Idempotent (IF NOT EXISTS) and memoised per warm instance.
let _ensured = false;
export async function ensurePitTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS pit_messages (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT,
    tier TEXT,
    body TEXT NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pit_messages_created ON pit_messages (created_at)`);
  await db.execute(sql`ALTER TABLE pit_messages ADD COLUMN IF NOT EXISTS handle TEXT`);   // Phase 2
  await db.execute(sql`CREATE TABLE IF NOT EXISTS pit_reports (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL,
    reporter_user_id TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pit_reports_message ON pit_reports (message_id)`);
  _ensured = true;
}

// ── Ably (REST, server) — token minting + server-authoritative publish ──
let _rest = null;
export function ablyRest() {
  if (!process.env.ABLY_API_KEY) return null;
  if (!_rest) _rest = new Rest(process.env.ABLY_API_KEY);
  return _rest;
}

// Broadcast an event to everyone in the room. Best-effort: a publish failure never blocks
// the DB write (the message is already persisted; clients also poll history on open).
export async function pitPublish(event, data) {
  const rest = ablyRest();
  if (!rest) return;
  try { await rest.channels.get(PIT_CHANNEL).publish(event, data); }
  catch (e) { console.log(`[pit] publish ${event} failed: ${e.message}`); }
}

// ── Identity snapshot (from the community profile — the source of truth since Phase 2) ──
export async function getIdentity(userId) {
  try {
    const p = await getOrCreateProfile(userId);
    return {
      username: p.displayName || p.handle || 'Trader',
      handle: p.handle || null,
      avatarUrl: p.avatarUrl || null,
    };
  } catch {
    return { username: 'Trader', handle: null, avatarUrl: null };
  }
}

export async function isAdminUser(userId) {
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  if (!userId || !ADMIN_EMAIL) return false;
  try {
    const u = await (await clerkClient()).users.getUser(userId);
    const email =
      u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress ||
      u.emailAddresses[0]?.emailAddress;
    return !!email && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  } catch { return false; }
}

// ── Sanitization + light profanity mask (v1 moderation) ──
// Basic list; masks the middle of a matched word so posting still works but slurs/spam are muted.
// This is a floor, not a full moderation system — admin delete + reports back it up.
const BLOCKED = ['fuck', 'shit', 'bitch', 'cunt', 'nigger', 'faggot', 'retard'];
const BLOCKED_RE = new RegExp(`\\b(${BLOCKED.join('|')})\\b`, 'gi');
const mask = (w) => (w.length <= 2 ? '*'.repeat(w.length) : w[0] + '*'.repeat(w.length - 1));

export function sanitizeBody(raw) {
  let s = String(raw || '')
    .replace(/[<>]/g, '')                 // strip angle brackets (no HTML injection into cards)
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (s.length > MAX_BODY) s = s.slice(0, MAX_BODY).trim();
  s = s.replace(BLOCKED_RE, (m) => mask(m));
  return s;
}

// ── KV rate limiter (Upstash REST): allow RATE_MAX per RATE_WINDOW per key ──
export async function rateLimited(key) {
  if (!KV_URL || !KV_TOKEN) return false;   // no KV → don't block (fail open)
  try {
    const r = await fetch(`${KV_URL}/incr/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store',
    });
    const { result } = await r.json();
    const n = Number(result) || 0;
    if (n === 1) {
      // first hit in the window → set the expiry
      await fetch(`${KV_URL}/expire/${encodeURIComponent(key)}/${RATE_WINDOW}`, {
        method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store',
      });
    }
    return n > RATE_MAX;
  } catch { return false; }
}
