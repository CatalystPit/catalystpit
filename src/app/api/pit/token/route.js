import { auth } from '@clerk/nextjs/server';
import { ablyRest, PIT_CHANNEL } from '../../../../lib/pit';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Mints an Ably token for a visitor. EVERYONE gets `subscribe` (read the room). Signed-in users
// also get `presence` (so they appear in "who's online"); anonymous visitors get subscribe only
// and can't enter presence (no clientId). Posting does NOT go through Ably publish — it routes
// through /api/pit/messages, which is the real Pro gate — so no client is granted `publish`.
export async function GET()  { return mint(); }
export async function POST() { return mint(); }

async function mint() {
  const rest = ablyRest();
  if (!rest) return Response.json({ error: 'chat_disabled' }, { status: 503, headers: NO_STORE });

  const { userId } = await auth();   // no-throw when signed out
  const capability = userId
    ? { [PIT_CHANNEL]: ['subscribe', 'presence'] }
    : { [PIT_CHANNEL]: ['subscribe'] };

  try {
    const tokenRequest = await rest.auth.createTokenRequest({
      capability: JSON.stringify(capability),
      ...(userId ? { clientId: userId } : {}),
    });
    return Response.json(tokenRequest, { headers: NO_STORE });
  } catch (e) {
    console.log(`[pit_token] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
