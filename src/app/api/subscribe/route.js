export const runtime = 'nodejs';

// Newsletter signup → Beehiiv v2 API. The API key stays server-side (never shipped to
// the browser). Set BEEHIIV_API_KEY + BEEHIIV_PUBLICATION_ID in the environment; until
// then this returns a clean 503 'not_configured' so the card shows a soft message
// instead of a hard error. No 6 AM promise is made here (see the Brief card copy).
const API_KEY = process.env.BEEHIIV_API_KEY;
const PUB_ID  = process.env.BEEHIIV_PUBLICATION_ID;

// Sanity check only — not RFC-perfect; rejects obvious junk before calling Beehiiv.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  let email;
  try {
    const body = await request.json();
    email = String(body?.email ?? '').trim().toLowerCase();
  } catch {
    return Response.json({ ok: false, error: 'invalid request' }, { status: 400 });
  }
  if (!EMAIL_RE.test(email)) {
    return Response.json({ ok: false, error: 'invalid email' }, { status: 400 });
  }
  if (!API_KEY || !PUB_ID) {
    console.log('[subscribe] BEEHIIV_API_KEY / BEEHIIV_PUBLICATION_ID not set');
    return Response.json({ ok: false, error: 'not_configured' }, { status: 503 });
  }
  try {
    const r = await fetch(`https://api.beehiiv.com/v2/publications/${PUB_ID}/subscriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        reactivate_existing: true,      // a returning/unsubscribed email re-subscribes cleanly
        send_welcome_email: true,
        utm_source: 'catalystpit',
        utm_medium: 'website',
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.log(`[subscribe] beehiiv ${r.status}: ${detail.slice(0, 200)}`);
      return Response.json({ ok: false, error: 'subscribe_failed' }, { status: 502 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    console.log(`[subscribe] error: ${e.message}`);
    return Response.json({ ok: false, error: 'subscribe_failed' }, { status: 502 });
  }
}
