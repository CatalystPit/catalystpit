import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../lib/db';
import { pitMessages, pitProfiles, pitMessageReactions } from '../../../../lib/schema';
import { eq, desc, sql, and, inArray } from 'drizzle-orm';
import { resolveUserTier } from '../../../../lib/entitlements';
import {
  getIdentity, isAdminUser, sanitizeBody, rateLimited, pitPublish, ensurePitTables,
} from '../../../../lib/pit';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const HISTORY = 60;   // recent messages sent on open

// GET — recent history (open to everyone) + the viewer's own context (can they post? are they admin?)
export async function GET() {
  // Resolve auth OUTSIDE the try so the response always reports login state even if the DB query
  // fails (otherwise a query error looks like "signed out" to the client).
  let userId = null;
  try { ({ userId } = await auth()); } catch { /* signed out */ }

  let tier = 'free';
  let admin = false;
  try {
    tier = await resolveUserTier();
    admin = userId ? await isAdminUser(userId) : false;
    const isPro = tier === 'pro' || tier === 'elite';

    await ensurePitTables();
    // Resolve identity LIVE from the author's current profile (fall back to the snapshot for
    // authors without a profile), so renaming a handle/display name never breaks old message links.
    const rows = await db.select({
      id: pitMessages.id, userId: pitMessages.userId,
      username: sql`coalesce(${pitProfiles.displayName}, ${pitMessages.username})`,
      handle:   sql`coalesce(${pitProfiles.handle}, ${pitMessages.handle})`,
      avatarUrl: sql`coalesce(${pitProfiles.avatarUrl}, ${pitMessages.avatarUrl})`,
      tier: pitMessages.tier, body: pitMessages.body, createdAt: pitMessages.createdAt,
    })
      .from(pitMessages)
      .leftJoin(pitProfiles, eq(pitProfiles.userId, pitMessages.userId))
      .where(eq(pitMessages.deleted, false))
      .orderBy(desc(pitMessages.createdAt))
      .limit(HISTORY);

    const messages = rows.reverse();   // oldest→newest for display

    // Attach reaction counts (+ which the viewer used) for these messages.
    const ids = messages.map((m) => m.id);
    if (ids.length) {
      const counts = await db.select({
        messageId: pitMessageReactions.messageId, emoji: pitMessageReactions.emoji,
        n: sql`count(*)`.mapWith(Number),
      })
        .from(pitMessageReactions).where(inArray(pitMessageReactions.messageId, ids))
        .groupBy(pitMessageReactions.messageId, pitMessageReactions.emoji);
      let mine = new Set();
      if (userId) {
        const mrows = await db.select({ messageId: pitMessageReactions.messageId, emoji: pitMessageReactions.emoji })
          .from(pitMessageReactions).where(and(inArray(pitMessageReactions.messageId, ids), eq(pitMessageReactions.userId, userId)));
        mine = new Set(mrows.map((r) => `${r.messageId}|${r.emoji}`));
      }
      const byMsg = {};
      for (const c of counts) (byMsg[c.messageId] ||= []).push({ emoji: c.emoji, count: c.n, mine: mine.has(`${c.messageId}|${c.emoji}`) });
      for (const m of messages) m.reactions = byMsg[m.id] || [];
    }

    return Response.json(
      // The Pit is open to all signed-in users — canPost = signed in.
      { messages, me: { userId, tier, canPost: !!userId, admin, loggedIn: !!userId } },
      { headers: NO_STORE },
    );
  } catch (e) {
    console.log(`[pit_messages] GET failed: ${e.message}`);
    // Preserve login/admin context so the composer still resolves correctly, and surface the
    // error so we can diagnose (e.g. missing table on the connected DB branch).
    return Response.json(
      { messages: [], me: { userId, tier, canPost: !!userId, admin, loggedIn: !!userId }, error: e.message },
      { status: 200, headers: NO_STORE },
    );
  }
}

// POST — send a message. Signed-in AND Pro/Elite only (the hard gate). Rate-limited + sanitized.
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });

    // The Pit is open to ALL signed-in users (free + pro). We still record the poster's tier so
    // Pro members can be shown with a distinct name color in chat.
    const tier = await resolveUserTier();

    if (await rateLimited(`pit:rl:${userId}`))
      return Response.json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });

    await ensurePitTables();
    const { body } = await request.json().catch(() => ({}));
    const clean = sanitizeBody(body);
    if (!clean) return Response.json({ error: 'empty' }, { status: 400, headers: NO_STORE });

    const { username, handle, avatarUrl } = await getIdentity(userId);
    // Stamp the author's role for name-color: 'admin' (operator) > 'pro'/'elite' > 'free'.
    const role = (await isAdminUser(userId)) ? 'admin' : tier;
    const [row] = await db.insert(pitMessages)
      .values({ userId, username, handle, avatarUrl, tier: role, body: clean })
      .returning({
        id: pitMessages.id, userId: pitMessages.userId, username: pitMessages.username,
        handle: pitMessages.handle, avatarUrl: pitMessages.avatarUrl, tier: pitMessages.tier,
        body: pitMessages.body, createdAt: pitMessages.createdAt,
      });

    await pitPublish('message', row);   // broadcast live (best-effort; already persisted)
    return Response.json({ message: row }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[pit_messages] POST failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}

// DELETE — admin moderation. Soft-deletes a message and tells clients to remove it live.
export async function DELETE(request) {
  try {
    const { userId } = await auth();
    if (!userId || !(await isAdminUser(userId)))
      return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });

    const { searchParams } = new URL(request.url);
    const id = parseInt(searchParams.get('id') ?? '', 10);
    if (!Number.isFinite(id)) return Response.json({ error: 'bad_id' }, { status: 400, headers: NO_STORE });

    await ensurePitTables();
    await db.update(pitMessages).set({ deleted: true }).where(eq(pitMessages.id, id));
    await pitPublish('delete', { id });
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[pit_messages] DELETE failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
