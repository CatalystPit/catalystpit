import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * THE TAPE'S POSTS, READ SERVER-SIDE FROM X'S PUBLIC SYNDICATION DOCUMENT.
 *
 * ── ⚠️ WHY THIS EXISTS: THE EMBED IS BROKEN AT X'S END, NOT OURS ─────────────────────────────────
 *
 * The tape was X's own iframe embed, and that embed stopped working. Measured repeatedly on the live
 * site in a real (non-headless) browser:
 *
 *     200  syndication.twitter.com/srv/timeline-list/list-id/<id>?embedId=twitter-widget-0   0 bytes
 *
 * X accepts the embed's request and returns an EMPTY document, so widgets.js leaves its iframe at
 * 0x0 with visibility:hidden and never renders. Nothing in our code can fix that: the request is
 * built and sent by X's own script.
 *
 * ── ⚠️ AND YET THE SAME URL WORKS FROM OUR SERVER ────────────────────────────────────────────────
 *
 * /api/x-tape/head has been fetching that identical document server-side for months and still gets
 * a full timeline — 99 entries, seconds old. The List is public, the posts exist, and X serves the
 * document; it just will not serve it to the embed path. So the posts come from the read that works.
 *
 * This is the same document, the same List and the same content the embed was showing. Nothing is
 * synthesised: every field rendered is copied from X's payload, and a post with no text is dropped
 * rather than padded.
 *
 * ── ⚠️ IT MAKES FAR FEWER REQUESTS OF X THAN THE EMBED DID ───────────────────────────────────────
 *
 * The embed cost one syndication request per visitor per rebuild, billed to the VISITOR's IP, and
 * syndication rate-limits per IP hard enough that a single tape left open could throttle itself.
 * This is ONE read per CACHE_MS shared by every visitor, from our address, with the last good
 * payload answering everything in between. Fewer requests of X, not more.
 *
 * Attribution is carried on every post — author name, @handle, avatar, timestamp and a link to the
 * post itself on x.com — and the panel links to the List.
 */

const LIST_URL = process.env.NEXT_PUBLIC_X_LIST_URL || 'https://x.com/i/lists/2096931068477620423';
const LIST_ID = (LIST_URL.match(/lists\/(\d+)/) || [])[1] || null;

// ⚠️ SLOWER THAN THE CLIENT POLLS, ON PURPOSE. Syndication's per-IP limit is tight — a sustained
// ~7 requests/minute earned a 429 in earlier testing — and every browser asking us more often costs
// nothing, while X being asked more often costs the whole feed.
const CACHE_MS = 30_000;
// A payload we cannot refresh is still worth showing: posts minutes old beat an empty panel. Past
// this, say so rather than pretending the tape is current.
const STALE_OK_MS = 10 * 60_000;
const TIMEOUT_MS = 7000;
const MAX_POSTS = 40;

// A browser-shaped request. Syndication answers a bare fetch with a different (or empty) body, so
// the User-Agent and Referer have to look like a page load — the same reason /head sends these.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  referer: 'https://catalystpit.com/',
};

/**
 * t.co links back to what they point at, and the trailing media link removed.
 *
 * ⚠️ THE URL ENTITIES ARE THE ONLY HONEST SOURCE for what a t.co points to — guessing from the
 * surrounding text would be inventing a destination. A t.co with no matching entity is left exactly
 * as X wrote it rather than stripped, because a shortened link that still resolves is better than a
 * sentence with a hole in it.
 */
function expandText(tweet) {
  let text = tweet.full_text || tweet.text || '';
  const urls = tweet.entities?.urls || [];
  for (const u of urls) {
    if (!u?.url) continue;
    // A media link is the post's own photo/video permalink and reads as noise next to the text.
    const isSelfMedia = u.expanded_url && /\/(photo|video)\/\d+$/.test(u.expanded_url);
    text = text.split(u.url).join(isSelfMedia ? '' : (u.display_url || u.expanded_url || u.url));
  }
  return text.replace(/\s+/g, ' ').trim();
}

async function readList() {
  if (!LIST_ID) throw new Error('no list configured');
  const qs = new URLSearchParams({
    dnt: 'false', frame: 'false', hideBorder: 'false', hideFooter: 'true', hideHeader: 'true',
    hideScrollBar: 'false', lang: 'en', maxHeight: '560', origin: 'https://catalystpit.com/terminal',
    showHeader: 'false', theme: 'light', transparent: 'false',
    embedId: `twitter-widget-${Math.floor(Math.random() * 1e9)}`,
  });
  const r = await fetch(`https://syndication.twitter.com/srv/timeline-list/list-id/${LIST_ID}?${qs}`,
    { headers: HEADERS, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`syndication ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no timeline payload');
  const entries = JSON.parse(m[1])?.props?.pageProps?.timeline?.entries || [];

  const posts = [];
  for (const e of entries) {
    const t = e?.content?.tweet;
    if (!t?.id_str) continue;
    const text = expandText(t);
    // ⚠️ A POST WITH NOTHING TO READ IS DROPPED, NOT PADDED. An image-only post renders as an empty
    // row, and an empty row in a news tape looks like a bug or, worse, like missing content.
    if (!text) continue;
    const handle = t.user?.screen_name || '';
    posts.push({
      id: t.id_str,
      text,
      at: Date.parse(t.created_at) || null,
      name: t.user?.name || handle,
      handle,
      avatar: t.user?.profile_image_url_https || null,
      // Permalink comes from X as a site-relative path; absolute is what a link needs.
      url: handle ? `https://x.com/${handle}/status/${t.id_str}` : `https://x.com/i/status/${t.id_str}`,
    });
    if (posts.length >= MAX_POSTS) break;
  }
  if (!posts.length) throw new Error('no readable posts');
  return { posts, n: posts.length, head: posts[0].id, at: posts[0].at };
}

let good = { at: 0, body: null };   // last SUCCESSFUL read, shared by every visitor
let triedAt = 0;
let lastError = null;

export async function GET() {
  const now = Date.now();
  // Stamped BEFORE the await so a burst of visitors produces one upstream read, not one each. A
  // failed read counts as an attempt: backing off is the point of a per-IP limit, and hammering X
  // while it refuses us is what keeps it refusing.
  if (now - triedAt >= CACHE_MS) {
    triedAt = now;
    try { good = { at: now, body: await readList() }; lastError = null; }
    catch (e) { lastError = String(e?.message || e).slice(0, 90); }
  }

  const age = Date.now() - good.at;
  if (good.body && age <= STALE_OK_MS) {
    return NextResponse.json({ ...good.body, ageMs: age, stale: age > CACHE_MS * 2 },
      { headers: { 'Cache-Control': 'private, no-store' } });
  }
  // ⚠️ AN HONEST EMPTY, so the client shows its fallback instead of an indefinite wait. `upstream`
  // makes "X refused us" distinguishable from "our parser broke" without a second request.
  return NextResponse.json({ posts: [], n: 0, upstream: lastError || 'no read yet' },
    { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
}
