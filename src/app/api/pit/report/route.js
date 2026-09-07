import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../lib/db';
import { pitReports } from '../../../../lib/schema';
import { ensurePitTables } from '../../../../lib/pit';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Any signed-in user can flag a message for admin review. Stored in pit_reports (append-only).
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: NO_STORE });

    const { messageId, reason } = await request.json().catch(() => ({}));
    const id = parseInt(messageId, 10);
    if (!Number.isFinite(id)) return Response.json({ error: 'bad_id' }, { status: 400, headers: NO_STORE });

    await ensurePitTables();
    await db.insert(pitReports).values({
      messageId: id,
      reporterUserId: userId,
      reason: (reason ? String(reason) : '').slice(0, 200) || null,
    });
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[pit_report] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
