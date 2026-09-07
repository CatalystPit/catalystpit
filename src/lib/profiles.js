import { clerkClient } from '@clerk/nextjs/server';
import { sql, eq, desc, and } from 'drizzle-orm';
import { db } from './db';
import { pitProfiles, pitMessages, watchlist } from './schema';

// Community profile helpers (Phase 2). Self-creates its table (like the Pit chat) so it's immune
// to Neon-branch migration mismatch. A profile is auto-created with a default handle on first
// activity; users customize it via PATCH /api/profile.

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
export const BIO_MAX = 280;

let _ensured = false;
export async function ensureProfileTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS pit_profiles (
    user_id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    display_name TEXT,
    bio TEXT,
    avatar_url TEXT,
    x_handle TEXT,
    ig_handle TEXT,
    show_watchlist BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_pit_profiles_handle ON pit_profiles (handle)`);
  await db.execute(sql`ALTER TABLE pit_profiles ADD COLUMN IF NOT EXISTS ig_handle TEXT`);   // Phase 3
  // pit_messages predates Phase 2 — add the handle column if the table already exists.
  await db.execute(sql`ALTER TABLE pit_messages ADD COLUMN IF NOT EXISTS handle TEXT`);
  _ensured = true;
}

// Social handle: allow letters, numbers, dot, underscore (covers X + Instagram). No @.
export function normalizeSocial(raw) {
  return String(raw || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9._]/g, '').slice(0, 30);
}

// Normalize a desired handle to the allowed charset (lowercase alnum + underscore).
export function normalizeHandle(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, HANDLE_MAX);
}
export function validHandle(h) {
  return typeof h === 'string' && new RegExp(`^[a-z0-9_]{${HANDLE_MIN},${HANDLE_MAX}}$`).test(h);
}

// Is a handle free (optionally ignoring the current owner)?
async function handleAvailable(handle, exceptUserId) {
  const rows = await db.select({ userId: pitProfiles.userId }).from(pitProfiles)
    .where(eq(pitProfiles.handle, handle)).limit(1);
  if (!rows.length) return true;
  return exceptUserId ? rows[0].userId === exceptUserId : false;
}

// Derive a unique default handle from Clerk username / name / id, appending digits on collision.
async function defaultHandle(userId, clerkUser) {
  let base = normalizeHandle(
    clerkUser?.username ||
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join('') ||
    `trader${userId.slice(-6)}`,
  );
  if (base.length < HANDLE_MIN) base = `trader${userId.slice(-6)}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
  base = base.slice(0, HANDLE_MAX);
  let candidate = base;
  for (let i = 0; i < 20; i++) {
    if (await handleAvailable(candidate)) return candidate;
    const suffix = String(i + 2);
    candidate = base.slice(0, HANDLE_MAX - suffix.length) + suffix;
  }
  return `${base.slice(0, 8)}${userId.slice(-6)}`;   // last-resort unique-ish
}

// Fetch a profile row by userId, creating a default one from Clerk data if none exists.
export async function getOrCreateProfile(userId) {
  await ensureProfileTables();
  const existing = await db.select().from(pitProfiles).where(eq(pitProfiles.userId, userId)).limit(1);
  if (existing.length) return existing[0];

  let clerkUser = null;
  try { clerkUser = await (await clerkClient()).users.getUser(userId); } catch { /* offline default */ }
  const handle = await defaultHandle(userId, clerkUser);
  const displayName =
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(' ').trim() ||
    clerkUser?.username || 'Trader';
  const avatarUrl = clerkUser?.imageUrl || null;

  try {
    const [row] = await db.insert(pitProfiles)
      .values({ userId, handle, displayName, avatarUrl })
      .onConflictDoNothing({ target: pitProfiles.userId })
      .returning();
    if (row) return row;
  } catch { /* race → fall through to re-read */ }
  const again = await db.select().from(pitProfiles).where(eq(pitProfiles.userId, userId)).limit(1);
  return again[0] || { userId, handle, displayName, avatarUrl, bio: null, xHandle: null, showWatchlist: false };
}

// Update the caller's own profile. Returns { ok, profile } or { ok:false, error }.
export async function updateProfile(userId, patch) {
  await ensureProfileTables();
  const set = { updatedAt: new Date() };

  if (patch.handle != null) {
    const h = normalizeHandle(patch.handle);
    if (!validHandle(h)) return { ok: false, error: 'invalid_handle' };
    if (!(await handleAvailable(h, userId))) return { ok: false, error: 'handle_taken' };
    set.handle = h;
  }
  if (patch.displayName != null) set.displayName = String(patch.displayName).slice(0, 60).trim() || null;
  if (patch.bio != null) set.bio = String(patch.bio).replace(/[<>]/g, '').slice(0, BIO_MAX).trim() || null;
  if (patch.xHandle != null) set.xHandle = normalizeSocial(patch.xHandle) || null;
  if (patch.igHandle != null) set.igHandle = normalizeSocial(patch.igHandle) || null;
  if (patch.showWatchlist != null) set.showWatchlist = !!patch.showWatchlist;

  await getOrCreateProfile(userId);   // ensure a row exists to update
  const [row] = await db.update(pitProfiles).set(set).where(eq(pitProfiles.userId, userId)).returning();
  return { ok: true, profile: row };
}

// Public view of a profile by handle: identity + recent Pit messages + (opt-in) watchlist.
export async function getPublicProfile(handle) {
  await ensureProfileTables();
  const h = normalizeHandle(handle);
  const rows = await db.select().from(pitProfiles).where(eq(pitProfiles.handle, h)).limit(1);
  if (!rows.length) return null;
  const p = rows[0];

  const recent = await db.select({
    id: pitMessages.id, body: pitMessages.body, createdAt: pitMessages.createdAt,
  })
    .from(pitMessages)
    .where(and(eq(pitMessages.userId, p.userId), eq(pitMessages.deleted, false)))
    .orderBy(desc(pitMessages.createdAt))
    .limit(20);

  let tickers = [];
  if (p.showWatchlist) {
    try {
      const w = await db.select({ ticker: watchlist.ticker }).from(watchlist)
        .where(eq(watchlist.userId, p.userId)).orderBy(desc(watchlist.addedAt)).limit(50);
      tickers = w.map((r) => r.ticker);
    } catch { /* watchlist table absent → none */ }
  }

  return {
    userId: p.userId,          // used server-side by the profile route for follow state
    handle: p.handle,
    displayName: p.displayName || p.handle,
    bio: p.bio || null,
    avatarUrl: p.avatarUrl || null,
    xHandle: p.xHandle || null,
    igHandle: p.igHandle || null,
    showWatchlist: p.showWatchlist,
    joinedAt: p.createdAt,
    recent,
    watchlist: tickers,
  };
}
