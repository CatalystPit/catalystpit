import { sql, eq, and, gte, inArray } from 'drizzle-orm';
import { db } from './db';
import { pitPosts, pitPostComments, pitPostLikes, pitFollows, pitMessages, pitProfiles } from './schema';
import { ensureCommunityTables } from './community';
import { ensurePitTables } from './pit';
import { ensureProfileTables } from './profiles';

// Community "Pit Score" leaderboard from existing activity. Weighted so quality (reactions
// received, followers) counts more than raw volume — discourages spam-to-rank.
const WEIGHTS = { posts: 3, comments: 1, likesReceived: 2, followers: 5, chat: 1 };
const WEEK = sql`now() - interval '7 days'`;

export async function getLeaderboard(window = 'all', limit = 25) {
  await Promise.all([ensureCommunityTables(), ensurePitTables(), ensureProfileTables()]);
  const wk = window === 'week';

  const rows = { posts: [], comments: [], likes: [], followers: [], chat: [] };
  try {
    rows.posts = await db.select({ userId: pitPosts.userId, n: sql`count(*)`.mapWith(Number) }).from(pitPosts)
      .where(wk ? and(eq(pitPosts.deleted, false), gte(pitPosts.createdAt, WEEK)) : eq(pitPosts.deleted, false))
      .groupBy(pitPosts.userId);
  } catch { /* table empty/missing */ }
  try {
    rows.comments = await db.select({ userId: pitPostComments.userId, n: sql`count(*)`.mapWith(Number) }).from(pitPostComments)
      .where(wk ? and(eq(pitPostComments.deleted, false), gte(pitPostComments.createdAt, WEEK)) : eq(pitPostComments.deleted, false))
      .groupBy(pitPostComments.userId);
  } catch { /* */ }
  try {
    // reactions RECEIVED — credited to the post's author
    rows.likes = await db.select({ userId: pitPosts.userId, n: sql`count(*)`.mapWith(Number) }).from(pitPostLikes)
      .innerJoin(pitPosts, eq(pitPosts.id, pitPostLikes.postId))
      .where(wk ? gte(pitPostLikes.createdAt, WEEK) : undefined)
      .groupBy(pitPosts.userId);
  } catch { /* */ }
  try {
    rows.followers = await db.select({ userId: pitFollows.followingId, n: sql`count(*)`.mapWith(Number) }).from(pitFollows)
      .where(wk ? gte(pitFollows.createdAt, WEEK) : undefined)
      .groupBy(pitFollows.followingId);
  } catch { /* */ }
  try {
    rows.chat = await db.select({ userId: pitMessages.userId, n: sql`count(*)`.mapWith(Number) }).from(pitMessages)
      .where(wk ? and(eq(pitMessages.deleted, false), gte(pitMessages.createdAt, WEEK)) : eq(pitMessages.deleted, false))
      .groupBy(pitMessages.userId);
  } catch { /* */ }

  const agg = new Map();
  const bump = (uid, key, n) => {
    if (!uid) return;
    const e = agg.get(uid) || { userId: uid, posts: 0, comments: 0, likesReceived: 0, followers: 0, chat: 0 };
    e[key] += n; agg.set(uid, e);
  };
  rows.posts.forEach((r) => bump(r.userId, 'posts', r.n));
  rows.comments.forEach((r) => bump(r.userId, 'comments', r.n));
  rows.likes.forEach((r) => bump(r.userId, 'likesReceived', r.n));
  rows.followers.forEach((r) => bump(r.userId, 'followers', r.n));
  rows.chat.forEach((r) => bump(r.userId, 'chat', r.n));

  const ids = [...agg.keys()];
  if (!ids.length) return [];

  const profiles = await db.select({
    userId: pitProfiles.userId, handle: pitProfiles.handle, displayName: pitProfiles.displayName, avatarUrl: pitProfiles.avatarUrl,
  }).from(pitProfiles).where(inArray(pitProfiles.userId, ids));
  const pmap = new Map(profiles.map((p) => [p.userId, p]));

  const list = [...agg.values()].map((e) => {
    const p = pmap.get(e.userId);
    const score = Math.round(e.posts * WEIGHTS.posts + e.comments * WEIGHTS.comments
      + e.likesReceived * WEIGHTS.likesReceived + e.followers * WEIGHTS.followers + e.chat * WEIGHTS.chat);
    return {
      handle: p?.handle || null,
      displayName: p?.displayName || p?.handle || 'Trader',
      avatarUrl: p?.avatarUrl || null,
      posts: e.posts, comments: e.comments, likesReceived: e.likesReceived, followers: e.followers, chat: e.chat,
      score,
    };
  }).filter((e) => e.score > 0);

  list.sort((a, b) => b.score - a.score);
  return list.slice(0, limit).map((e, i) => ({ rank: i + 1, ...e }));
}
