import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../lib/db';
import { pitMessageReactions } from '../../../../lib/schema';
import { and, eq, sql } from 'drizzle-orm';
import { REACTIONS, pitPublish, ensurePitTables } from '../../../../lib/pit';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// POST { messageId, emoji } → set the user's single reaction (mutually exclusive) or remove it
// (emoji null / re-picking the same one). Any signed-in user. Broadcasts the new aggregate counts.
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });

    const { messageId, emoji } = await request.json().catch(() => ({}));
    const id = parseInt(messageId, 10);
    if (!Number.isFinite(id)) return Response.json({ error: 'bad_id' }, { status: 400, headers: NO_STORE });

    await ensurePitTables();
    const [existing] = await db.select({ emoji: pitMessageReactions.emoji }).from(pitMessageReactions)
      .where(and(eq(pitMessageReactions.messageId, id), eq(pitMessageReactions.userId, userId))).limit(1);

    if (emoji && REACTIONS.includes(emoji)) {
      if (existing?.emoji === emoji) {
        await db.delete(pitMessageReactions).where(and(eq(pitMessageReactions.messageId, id), eq(pitMessageReactions.userId, userId)));
      } else {
        if (existing) await db.delete(pitMessageReactions).where(and(eq(pitMessageReactions.messageId, id), eq(pitMessageReactions.userId, userId)));
        await db.insert(pitMessageReactions).values({ messageId: id, userId, emoji }).onConflictDoNothing();
      }
    } else if (existing) {
      await db.delete(pitMessageReactions).where(and(eq(pitMessageReactions.messageId, id), eq(pitMessageReactions.userId, userId)));
    }

    const rows = await db.select({ emoji: pitMessageReactions.emoji, n: sql`count(*)`.mapWith(Number) })
      .from(pitMessageReactions).where(eq(pitMessageReactions.messageId, id)).groupBy(pitMessageReactions.emoji);
    const counts = {};
    for (const r of rows) counts[r.emoji] = r.n;

    await pitPublish('reaction', { messageId: id, counts, userId });
    return Response.json({ counts }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[pit_react] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
