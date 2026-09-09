import { auth } from '@clerk/nextjs/server';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { screenerSaved } from '../../../../lib/schema';
import { ensureScreenerTables } from '../../../../lib/screener-data';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

const shape = (r) => ({ id: r.id, name: r.name, filters: safe(r.filters), sortBy: r.sortBy, sortDir: r.sortDir, view: r.view, columns: safe(r.columns) });
const safe = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

async function list(userId) {
  const rows = await db.select().from(screenerSaved).where(eq(screenerSaved.userId, userId)).orderBy(desc(screenerSaved.createdAt));
  return rows.map(shape);
}

// GET → user's saved screeners.
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ saved: [] }, { headers: NO_STORE });
    await ensureScreenerTables();
    return Response.json({ saved: await list(userId) }, { headers: NO_STORE });
  } catch (e) { return Response.json({ saved: [], error: e.message }, { status: 200, headers: NO_STORE }); }
}

// POST { name, filters, sortBy, sortDir, view, columns } → create.
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    await ensureScreenerTables();
    const b = await request.json().catch(() => ({}));
    const name = String(b?.name || '').trim().slice(0, 60) || 'My Screener';
    await db.insert(screenerSaved).values({
      userId, name,
      filters: JSON.stringify(b?.filters || {}), sortBy: b?.sortBy || null, sortDir: b?.sortDir || null,
      view: b?.view || null, columns: b?.columns ? JSON.stringify(b.columns) : null,
    });
    return Response.json({ saved: await list(userId) }, { headers: NO_STORE });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}

// PATCH { id, name } → rename.
export async function PATCH(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const b = await request.json().catch(() => ({}));
    const id = parseInt(b?.id, 10);
    if (!id || !b?.name) return Response.json({ error: 'id and name required' }, { status: 400 });
    await db.update(screenerSaved).set({ name: String(b.name).trim().slice(0, 60) }).where(and(eq(screenerSaved.userId, userId), eq(screenerSaved.id, id)));
    return Response.json({ saved: await list(userId) }, { headers: NO_STORE });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}

// DELETE ?id= → remove.
export async function DELETE(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const id = parseInt(new URL(request.url).searchParams.get('id'), 10);
    if (id) await db.delete(screenerSaved).where(and(eq(screenerSaved.userId, userId), eq(screenerSaved.id, id)));
    return Response.json({ saved: await list(userId) }, { headers: NO_STORE });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
