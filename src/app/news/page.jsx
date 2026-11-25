import NewsFeed from '../../components/NewsFeed';
import { pageMeta } from '../../lib/seo';
import { readNewsRoom } from '../../lib/rooms-server.mjs';

export const metadata = pageMeta({
  // ⚠️ THE DESCRIPTION SHIPPED A LITERAL BACKSLASH. The source escaped an apostrophe inside a
  // DOUBLE-quoted string, where it needs no escape, so the backslash itself was emitted. Production
  // served it, and it appeared in the search snippet exactly as written.
  //
  // The title is also doing more work now. "News" is not a phrase anyone searches on its own, and
  // this room is two things a reader does search for — today's market headlines, and the SEC
  // filings behind the moves — which is also the distinction the page now draws in its ordering.
  title: { absolute: "Stock Market News Today · Market-Moving Headlines and SEC Filings · CatalystPit" },
  description: "Today's stock market news from the major financial newsrooms, with the material SEC 8-K filings behind the moves kept in a section of their own. Ordered by significance and publication time.",
  path: "/news",
});

// ── ⚠️ WHY THIS PAGE IS REGENERATED AND NOT RENDERED PER REQUEST ───────────
//
// Composing the river on the server makes this page no longer purely static, and there are two
// ways for that to land. Dynamic rendering would put two KV reads and an indexed 8-K query in
// front of first byte for every visitor; incremental regeneration keeps the HTML served from the
// edge exactly as it was, with that work happening on one background regeneration per window.
//
// ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT — Next statically analyses this export at build time and
// an imported identifier is accepted and then silently ignored. ROOM_CACHE_SECONDS in
// lib/rooms-server.mjs remains the single source of truth; verify-rooms-ssr asserts they agree.
//
// ⚠️ AND FIVE MINUTES IS SHORTER THAN THE WRITER, WHICH IS THE RULE THAT MATTERS.
// `catalystpit:top_stories` is refreshed by /api/refresh-content on `0 13-21 * * 1-5`, so this
// page can never serve HTML more than one generation behind the enrichment that produced it.
export const revalidate = 300;

export default async function NewsPage() {
  // ⚠️ ONE CLOCK FOR THE WHOLE RENDER. Every "4m ago" in this HTML is an AGE, so the instant it is
  // measured from is captured once here and passed through to the browser as part of the props.
  // React hydrates against these exact numbers; recomputing them client-side against a different
  // clock is a guaranteed mismatch, and a mismatch means React throws the server's HTML away — the
  // page still looks right while the copy a crawler read is the one nobody checked.
  //
  // ⚠️ null ON ANY FAILURE, AND THE CLIENT STILL OWNS THE OUTCOME. An unreadable cache degrades to
  // exactly what shipped before this change: the component's own fetch fills the feed in. The
  // server never publishes "no news" as a finding about the market.
  const initialData = await readNewsRoom({ now: Date.now() }).catch(() => null);
  return <NewsFeed initialData={initialData} />;
}
