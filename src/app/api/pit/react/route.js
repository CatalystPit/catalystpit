import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../lib/db';
import { pitMessageReactions } from '../../../../lib/schema';
import { and, eq } from 'drizzle-orm';
import { REACTIONS, pitPublish, ensurePitTables } from '../../../../lib/pit';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// POST { messageId, emoji, on } → add/remove a reaction. Any signed-in user (free or Pro).
// Broadcasts a 'reaction' delta so other clients update live; the actor updates optimistically.
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });

    const { messageId, emoji, on } = await request.json().catch(() => ({}));
    const id = parseInt(messageId, 10);
    if (!Number.isFinite(id) || !REACTIONS.includes(emoji))
      return Response.json({ error: 'bad_request' }, { status: 400, headers: NO_STORE });

    await ensurePitTables();
    if (on) {
      await db.insert(pitMessageReactions).values({ messageId: id, userId, emoji }).onConflictDoNothing();
    } else {
      await db.delete(pitMessageReactions).where(and(
        eq(pitMessageReactions.messageId, id), eq(pitMessageReactions.userId, userId), eq(pitMessageReactions.emoji, emoji),
      ));
    }
    await pitPublish('reaction', { messageId: id, emoji, delta: on ? 1 : -1, userId });
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[pit_react] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
