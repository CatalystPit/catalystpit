import { ablyRest, PIT_CHANNEL } from '../../../../lib/pit';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Public: how many members are currently present in The Pit (via Ably REST presence).
// Used by the homepage "Pit is live" widget without opening a client Ably connection.
export async function GET() {
  const rest = ablyRest();
  if (!rest) return Response.json({ online: 0 }, { headers: NO_STORE });
  try {
    const page = await rest.channels.get(PIT_CHANNEL).presence.get({ limit: 100 });
    const online = Array.isArray(page?.items) ? page.items.length : 0;
    return Response.json({ online }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[pit_presence] ${e.message}`);
    return Response.json({ online: 0 }, { headers: NO_STORE });
  }
}
