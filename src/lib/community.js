import { sql, eq, and, desc, lt, inArray } from 'drizzle-orm';
import { db } from './db';
import { pitFollows, pitPosts, pitPostLikes, pitPostComments, pitProfiles } from './schema';
import { sanitizeBody } from './pit';

// Follows + feed (Phase 3). Self-creates tables (immune to Neon-branch mismatch).

let _ensured = false;
export async function ensureCommunityTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS pit_follows (
    follower_id TEXT NOT NULL,
    following_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, following_id)
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pit_follows_following ON pit_follows (following_id)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS pit_posts (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    handle TEXT,
    username TEXT NOT NULL,
    avatar_url TEXT,
    body TEXT NOT NULL,
    like_count INTEGER NOT NULL DEFAULT 0,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pit_posts_created ON pit_posts (created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pit_posts_user ON pit_posts (user_id)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS pit_post_likes (
    post_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id)
  )`);
  await db.execute(sql`ALTER TABLE pit_posts ADD COLUMN IF NOT EXISTS comment_count INTEGER NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE pit_posts ADD COLUMN IF NOT EXISTS image_url TEXT`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS pit_post_comments (
    id SERIAL PRIMARY KEY,
    post_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    handle TEXT,
    username TEXT NOT NULL,
    avatar_url TEXT,
    body TEXT NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pit_comments_post ON pit_post_comments (post_id)`);
  _ensured = true;
}

// ── Follows ──
export async function followUser(followerId, followingId) {
  if (!followerId || !followingId || followerId === followingId) return;
  await ensureCommunityTables();
  await db.insert(pitFollows).values({ followerId, followingId }).onConflictDoNothing();
}
export async function unfollowUser(followerId, followingId) {
  await ensureCommunityTables();
  await db.delete(pitFollows).where(and(eq(pitFollows.followerId, followerId), eq(pitFollows.followingId, followingId)));
}
export async function getFollowState(viewerId, targetUserId) {
  await ensureCommunityTables();
  const [f1] = await db.select({ n: sql`count(*)`.mapWith(Number) }).from(pitFollows).where(eq(pitFollows.followingId, targetUserId));
  const [f2] = await db.select({ n: sql`count(*)`.mapWith(Number) }).from(pitFollows).where(eq(pitFollows.followerId, targetUserId));
  let isFollowing = false;
  if (viewerId && viewerId !== targetUserId) {
    const r = await db.select({ x: pitFollows.followerId }).from(pitFollows)
      .where(and(eq(pitFollows.followerId, viewerId), eq(pitFollows.followingId, targetUserId))).limit(1);
    isFollowing = r.length > 0;
  }
  return { followers: f1?.n || 0, following: f2?.n || 0, isFollowing };
}

// ── Feed ──
export async function createPost(userId, identity, body, imageUrl = null) {
  await ensureCommunityTables();
  const clean = sanitizeBody(body);
  if (!clean && !imageUrl) return null;   // allow image-only posts
  const [row] = await db.insert(pitPosts).values({
    userId, handle: identity.handle || null, username: identity.username || 'Trader',
    avatarUrl: identity.avatarUrl || null, body: clean || '', imageUrl: imageUrl || null,
  }).returning();
  return { ...row, liked: false };
}

export async function listFeed({ scope = 'global', viewerId = null, limit = 30, before = null } = {}) {
  await ensureCommunityTables();
  const conds = [eq(pitPosts.deleted, false)];
  if (before) conds.push(lt(pitPosts.createdAt, new Date(before)));

  if (scope === 'following') {
    if (!viewerId) return [];
    const f = await db.select({ id: pitFollows.followingId }).from(pitFollows).where(eq(pitFollows.followerId, viewerId));
    const ids = f.map((x) => x.id);
    if (!ids.length) return [];
    conds.push(inArray(pitPosts.userId, ids));
  }

  // Resolve author identity LIVE from their current profile (fall back to snapshot) so renaming
  // never breaks post links.
  const rows = await db.select({
    id: pitPosts.id, userId: pitPosts.userId,
    username: sql`coalesce(${pitProfiles.displayName}, ${pitPosts.username})`,
    handle:   sql`coalesce(${pitProfiles.handle}, ${pitPosts.handle})`,
    avatarUrl: sql`coalesce(${pitProfiles.avatarUrl}, ${pitPosts.avatarUrl})`,
    body: pitPosts.body, imageUrl: pitPosts.imageUrl,
    likeCount: pitPosts.likeCount, commentCount: pitPosts.commentCount, createdAt: pitPosts.createdAt,
  })
    .from(pitPosts)
    .leftJoin(pitProfiles, eq(pitProfiles.userId, pitPosts.userId))
    .where(and(...conds)).orderBy(desc(pitPosts.createdAt)).limit(limit);

  // which of these has the viewer liked?
  let likedSet = new Set();
  if (viewerId && rows.length) {
    const liked = await db.select({ postId: pitPostLikes.postId }).from(pitPostLikes)
      .where(and(eq(pitPostLikes.userId, viewerId), inArray(pitPostLikes.postId, rows.map((r) => r.id))));
    likedSet = new Set(liked.map((l) => l.postId));
  }
  return rows.map((r) => ({ ...r, liked: likedSet.has(r.id) }));
}

export async function toggleLike(postId, userId, on) {
  await ensureCommunityTables();
  if (on) {
    const ins = await db.insert(pitPostLikes).values({ postId, userId }).onConflictDoNothing().returning({ postId: pitPostLikes.postId });
    if (ins.length) {
      const [r] = await db.update(pitPosts).set({ likeCount: sql`${pitPosts.likeCount} + 1` }).where(eq(pitPosts.id, postId)).returning({ likeCount: pitPosts.likeCount });
      return { liked: true, likeCount: r?.likeCount ?? null };
    }
  } else {
    const del = await db.delete(pitPostLikes).where(and(eq(pitPostLikes.postId, postId), eq(pitPostLikes.userId, userId))).returning({ postId: pitPostLikes.postId });
    if (del.length) {
      const [r] = await db.update(pitPosts).set({ likeCount: sql`GREATEST(${pitPosts.likeCount} - 1, 0)` }).where(eq(pitPosts.id, postId)).returning({ likeCount: pitPosts.likeCount });
      return { liked: false, likeCount: r?.likeCount ?? null };
    }
  }
  // no-op (already in desired state) → return current count
  const [r] = await db.select({ likeCount: pitPosts.likeCount }).from(pitPosts).where(eq(pitPosts.id, postId));
  return { liked: on, likeCount: r?.likeCount ?? null };
}

export async function deletePost(postId, userId, isAdmin) {
  await ensureCommunityTables();
  const [post] = await db.select({ userId: pitPosts.userId }).from(pitPosts).where(eq(pitPosts.id, postId)).limit(1);
  if (!post) return { ok: false, error: 'not_found' };
  if (!isAdmin && post.userId !== userId) return { ok: false, error: 'forbidden' };
  await db.update(pitPosts).set({ deleted: true }).where(eq(pitPosts.id, postId));
  return { ok: true };
}

// ── Comments ──
export async function addComment(postId, userId, identity, body) {
  await ensureCommunityTables();
  const clean = sanitizeBody(body);
  if (!clean) return null;
  const [row] = await db.insert(pitPostComments).values({
    postId, userId, handle: identity.handle || null, username: identity.username || 'Trader',
    avatarUrl: identity.avatarUrl || null, body: clean,
  }).returning();
  await db.update(pitPosts).set({ commentCount: sql`${pitPosts.commentCount} + 1` }).where(eq(pitPosts.id, postId));
  return row;
}

export async function listComments(postId, limit = 100) {
  await ensureCommunityTables();
  return db.select({
    id: pitPostComments.id, userId: pitPostComments.userId,
    username: sql`coalesce(${pitProfiles.displayName}, ${pitPostComments.username})`,
    handle:   sql`coalesce(${pitProfiles.handle}, ${pitPostComments.handle})`,
    avatarUrl: sql`coalesce(${pitProfiles.avatarUrl}, ${pitPostComments.avatarUrl})`,
    body: pitPostComments.body, createdAt: pitPostComments.createdAt,
  })
    .from(pitPostComments)
    .leftJoin(pitProfiles, eq(pitProfiles.userId, pitPostComments.userId))
    .where(and(eq(pitPostComments.postId, postId), eq(pitPostComments.deleted, false)))
    .orderBy(pitPostComments.createdAt).limit(limit);
}

export async function deleteComment(commentId, userId, isAdmin) {
  await ensureCommunityTables();
  const [c] = await db.select({ userId: pitPostComments.userId, postId: pitPostComments.postId })
    .from(pitPostComments).where(eq(pitPostComments.id, commentId)).limit(1);
  if (!c) return { ok: false, error: 'not_found' };
  if (!isAdmin && c.userId !== userId) return { ok: false, error: 'forbidden' };
  await db.update(pitPostComments).set({ deleted: true }).where(eq(pitPostComments.id, commentId));
  await db.update(pitPosts).set({ commentCount: sql`GREATEST(${pitPosts.commentCount} - 1, 0)` }).where(eq(pitPosts.id, c.postId));
  return { ok: true };
}
