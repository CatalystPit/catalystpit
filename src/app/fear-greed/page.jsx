import FearGreedClient from './FearGreedClient';
import { pageMeta } from '../../lib/seo';
import { readFearGreedRoom } from '../../lib/rooms-server.mjs';

export const metadata = pageMeta({
  title: { absolute: 'Fear & Greed · CatalystPit' },
  description: 'Catalyst Pit Fear & Greed: a daily 0-100 read on U.S. equity risk sentiment, '
    + 'built from market momentum, realized volatility, breadth, price strength and credit appetite — '
    + 'each scored against its own two-year distribution, with every component shown.',
  path: '/fear-greed',
});

// ── ⚠️ WHY THIS PAGE IS REGENERATED AND NOT RENDERED PER REQUEST ───────────
//
// Measured on production as Googlebot: 53 words — the lowest of any indexable room except
// /screener — on a page whose whole subject is a number and the reasoning behind it. The score, its
// zone, every component score and the published methodology were all arriving in an effect.
//
// The index is computed DAILY, so a five-minute window is far shorter than the write cadence that
// produces what it reads — the rule /api/market was corrected to follow. The route's own edge cache
// is already `public, s-maxage=300`, so the page and its first client refresh cannot disagree about
// how fresh the number is.
//
// ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT — Next statically analyses this export at build time and
// an imported identifier is accepted and then silently ignored. ROOM_CACHE_SECONDS in
// lib/rooms-server.mjs remains the single source of truth; verify-rooms-ssr asserts they agree.
export const revalidate = 300;

export default async function FearGreedPage() {
  // ⚠️ AN UNAVAILABLE INDEX IS A REAL ANSWER AND IS RENDERED AS ONE. The reader fails closed —
  // "no stored index" is never a 50 and never a guess — and the component already draws that
  // state. null here means only that the read itself failed, which leaves the client's own fetch
  // to decide, exactly as before this change.
  const initialData = await readFearGreedRoom().catch(() => null);
  return <FearGreedClient initialData={initialData} />;
}
