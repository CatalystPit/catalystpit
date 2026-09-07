import { sql, eq, and, desc } from 'drizzle-orm';
import { db } from './db';
import { pitNotifications } from './schema';
import { getOrCreateProfile } from './profiles';

// Notifications (Phase 4). Self-creating table. Best-effort: a notification write never blocks the
// action that triggered it (follow/like/comment) — failures are swallowed.

let _ensured = false;
export async function ensureNotifTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS pit_notifications (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    actor_user_id TEXT,
    actor_name TEXT,
    actor_handle TEXT,
    actor_avatar TEXT,
    type TEXT NOT NULL,
    post_id INTEGER,
    excerpt TEXT,
    read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pit_notifs_user ON pit_notifications (user_id, created_at)`);
  _ensured = true;
}

// Deliver a notification to `recipientUserId` about `actorUserId`'s action. No self-notifications.
export async function addNotification(recipientUserId, actorUserId, type, opts = {}) {
  try {
    if (!recipientUserId || !actorUserId || recipientUserId === actorUserId) return;
    await ensureNotifTables();
    let actor = {};
    try { actor = await getOrCreateProfile(actorUserId); } catch { /* default */ }
    await db.insert(pitNotifications).values({
      userId: recipientUserId,
      actorUserId,
      actorName: actor.displayName || actor.handle || 'Someone',
      actorHandle: actor.handle || null,
      actorAvatar: actor.avatarUrl || null,
      type,
      postId: opts.postId ?? null,
      excerpt: opts.excerpt ? String(opts.excerpt).slice(0, 120) : null,
    });
  } catch (e) { console.log(`[notif] add failed: ${e.message}`); }
}

export async function listNotifications(userId, limit = 30) {
  await ensureNotifTables();
  return db.select().from(pitNotifications)
    .where(eq(pitNotifications.userId, userId))
    .orderBy(desc(pitNotifications.createdAt)).limit(limit);
}

export async function unreadCount(userId) {
  await ensureNotifTables();
  const [r] = await db.select({ n: sql`count(*)`.mapWith(Number) }).from(pitNotifications)
    .where(and(eq(pitNotifications.userId, userId), eq(pitNotifications.read, false)));
  return r?.n || 0;
}

export async function markAllRead(userId) {
  await ensureNotifTables();
  await db.update(pitNotifications).set({ read: true })
    .where(and(eq(pitNotifications.userId, userId), eq(pitNotifications.read, false)));
}
