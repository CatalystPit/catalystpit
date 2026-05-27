export const runtime = 'nodejs';

const KV_URL     = process.env.KV_REST_API_URL;
const KV_TOKEN   = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.result;
}

export async function GET(request) {
  // Auth: Bearer CRON_SECRET only (no Vercel cron bypass — this is a debug tool, not a scheduled job)
  if (request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  if (!key) {
    return Response.json({ error: 'Missing ?key= query param' }, { status: 400 });
  }

  try {
    const raw = await kvGet(key);
    if (raw === null || raw === undefined) {
      return Response.json({ key, exists: false }, { status: 200 });
    }

    // KV typically stores JSON-stringified payloads; try to parse for richer inspection.
    let value = raw;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { /* leave as string */ }
    }

    const type = Array.isArray(value) ? 'array' : typeof value;
    const payload = { key, exists: true, type };
    if (Array.isArray(value)) {
      payload.length = value.length;
      payload.sample = value.slice(0, 3);
    } else {
      payload.value = value;
    }

    return Response.json(payload, { status: 200 });
  } catch (e) {
    return Response.json({ key, error: e.message }, { status: 500 });
  }
}

