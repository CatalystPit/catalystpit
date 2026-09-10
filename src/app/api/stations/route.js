import { auth } from '@clerk/nextjs/server';
import { sql, eq, and, desc } from 'drizzle-orm';
import { db } from '../../../lib/db';
import { terminalStations } from '../../../lib/schema';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

let _ensured = false;
async function ensure() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS terminal_stations (
    id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE, source_type TEXT DEFAULT 'custom', preset_key TEXT,
    layout TEXT, visible TEXT, settings TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stations_user ON terminal_stations (user_id)`);
  _ensured = true;
}

const safe = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const shape = (r) => ({ id: r.id, name: r.name, isDefault: !!r.isDefault, sourceType: r.sourceType || 'custom', presetKey: r.presetKey || null, layout: safe(r.layout), visible: safe(r.visible), settings: safe(r.settings) });

async function list(userId) {
  const rows = await db.select().from(terminalStations).where(eq(terminalStations.userId, userId)).orderBy(desc(terminalStations.updatedAt));
  return rows.map(shape);
}

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ stations: [] }, { headers: NO_STORE });
    await ensure();
    return Response.json({ stations: await list(userId) }, { headers: NO_STORE });
  } catch (e) { return Response.json({ stations: [], error: e.message }, { status: 200, headers: NO_STORE }); }
}

// POST { name, layout, visible, sourceType?, presetKey?, isDefault? } → create a custom station.
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    await ensure();
    const b = await request.json().catch(() => ({}));
    const name = String(b?.name || 'My Station').trim().slice(0, 60) || 'My Station';
    if (b?.isDefault) await db.update(terminalStations).set({ isDefault: false }).where(eq(terminalStations.userId, userId));
    const [row] = await db.insert(terminalStations).values({
      userId, name, isDefault: !!b?.isDefault, sourceType: b?.sourceType === 'preset' ? 'preset' : 'custom', presetKey: b?.presetKey || null,
      layout: JSON.stringify(b?.layout || {}), visible: JSON.stringify(b?.visible || []), settings: b?.settings ? JSON.stringify(b.settings) : null,
    }).returning({ id: terminalStations.id });
    return Response.json({ stations: await list(userId), id: row?.id }, { headers: NO_STORE });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}

// PATCH { id, name?, layout?, visible?, isDefault? } → update / rename / set-default.
export async function PATCH(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    await ensure();
    const b = await request.json().catch(() => ({}));
    const id = parseInt(b?.id, 10);
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    if (b?.isDefault) await db.update(terminalStations).set({ isDefault: false }).where(eq(terminalStations.userId, userId));
    const set = { updatedAt: new Date() };
    if (typeof b.name === 'string') set.name = b.name.trim().slice(0, 60);
    if (b.layout) set.layout = JSON.stringify(b.layout);
    if (b.visible) set.visible = JSON.stringify(b.visible);
    if (typeof b.isDefault === 'boolean') set.isDefault = b.isDefault;
    await db.update(terminalStations).set(set).where(and(eq(terminalStations.userId, userId), eq(terminalStations.id, id)));
    return Response.json({ stations: await list(userId) }, { headers: NO_STORE });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}

export async function DELETE(request) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
    await ensure();
    const id = parseInt(new URL(request.url).searchParams.get('id'), 10);
    if (id) await db.delete(terminalStations).where(and(eq(terminalStations.userId, userId), eq(terminalStations.id, id)));
    return Response.json({ stations: await list(userId) }, { headers: NO_STORE });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
