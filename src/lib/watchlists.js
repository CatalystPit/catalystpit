import { and, eq, isNull, sql, asc, desc } from 'drizzle-orm';
import { db } from './db';
import { watchlist, watchlistLists } from './schema';
import { WATCHLIST_LISTS_LIMIT } from './entitlements';

// Named watchlists (multiple = Pro perk). Self-creating table + lazy per-user migration into a
// default list — no manual migration, immune to Neon-branch mismatch (same pattern as the Pit).

let _ensured = false;
export async function ensureWatchlistTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS watchlist_lists (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_watchlist_lists_user ON watchlist_lists (user_id)`);
  await db.execute(sql`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS list_id INTEGER`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_watchlist_list ON watchlist (list_id)`);
  _ensured = true;
}

// Ensure the user has a default list, and lazily move any list-less tickers into it. Returns default.
export async function ensureDefaultList(userId) {
  await ensureWatchlistTables();
  const found = await db.select().from(watchlistLists)
    .where(and(eq(watchlistLists.userId, userId), eq(watchlistLists.isDefault, true))).limit(1);
  let def = found[0];
  if (!def) {
    const ins = await db.insert(watchlistLists).values({ userId, name: 'Watchlist', isDefault: true, position: 0 }).returning();
    def = ins[0];
  }
  // Backfill legacy rows (no list_id) into the default list.
  await db.update(watchlist).set({ listId: def.id }).where(and(eq(watchlist.userId, userId), isNull(watchlist.listId)));
  return def;
}

const normName = (raw) => String(raw ?? '').trim().slice(0, 40);

export async function getLists(userId) {
  const def = await ensureDefaultList(userId);
  const lists = await db.select({ id: watchlistLists.id, name: watchlistLists.name, isDefault: watchlistLists.isDefault })
    .from(watchlistLists).where(eq(watchlistLists.userId, userId))
    .orderBy(desc(watchlistLists.isDefault), asc(watchlistLists.position), asc(watchlistLists.id));
  // Per-list ticker counts (one grouped query).
  const counts = await db.select({ listId: watchlist.listId, n: sql`count(*)`.mapWith(Number) })
    .from(watchlist).where(eq(watchlist.userId, userId)).groupBy(watchlist.listId);
  const byList = new Map(counts.map((c) => [c.listId, c.n]));
  return { defaultId: def.id, lists: lists.map((l) => ({ ...l, count: byList.get(l.id) || 0 })) };
}

// Create a new named list. Enforces the per-tier list cap → { ok } | { error, limit }.
export async function createList(userId, name, tier) {
  await ensureDefaultList(userId);
  const limit = WATCHLIST_LISTS_LIMIT[tier] ?? WATCHLIST_LISTS_LIMIT.free;
  const existing = await db.select({ id: watchlistLists.id }).from(watchlistLists).where(eq(watchlistLists.userId, userId));
  if (existing.length >= limit) {
    return { error: limit <= 1 ? 'Multiple watchlists are a Pro feature.' : `You've reached your ${limit}-list limit.`, limit };
  }
  const nm = normName(name) || 'New list';
  const ins = await db.insert(watchlistLists).values({ userId, name: nm, isDefault: false, position: existing.length }).returning();
  return { ok: true, list: ins[0] };
}

export async function renameList(userId, id, name) {
  const nm = normName(name);
  if (!nm) return { error: 'Name required' };
  await db.update(watchlistLists).set({ name: nm }).where(and(eq(watchlistLists.userId, userId), eq(watchlistLists.id, id)));
  return { ok: true };
}

// Delete a list (never the default) and its tickers.
export async function deleteList(userId, id) {
  const [row] = await db.select().from(watchlistLists).where(and(eq(watchlistLists.userId, userId), eq(watchlistLists.id, id))).limit(1);
  if (!row) return { error: 'Not found' };
  if (row.isDefault) return { error: "Can't delete your default list" };
  await db.delete(watchlist).where(and(eq(watchlist.userId, userId), eq(watchlist.listId, id)));
  await db.delete(watchlistLists).where(and(eq(watchlistLists.userId, userId), eq(watchlistLists.id, id)));
  return { ok: true };
}
