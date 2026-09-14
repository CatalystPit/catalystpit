import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Freshness signal for the Terminal's "Tape (via X)" panel — NOT a feed.
//
// The tape itself is, and stays, X's own embed: a cross-origin iframe we cannot read into. That
// embed renders a SNAPSHOT at creation time and never polls, so the only way to show a new post is
// to rebuild it. Rebuilding blindly on a timer is what we shipped first, and it is worse than it
// sounds: every rebuild is a syndication request billed to the VISITOR's IP, X rate-limits that per
// visitor with 429s, and a refused rebuild silently leaves the old tape on screen. A tape left open
// therefore spends its whole rate-limit budget re-fetching a timeline that has not changed, and is
// then throttled at the exact moment a real post lands.
//
// This route answers one question — "what is the newest post id on the list right now?" — so the
// browser only spends an X request when there is actually something new to show. It returns NO post
// content: an id, a timestamp and a count. Nothing is stored, nothing is rendered from it, and the
// tape's text still comes from X's embed and nowhere else.
//
// It reads the same public syndication document the visitor's own browser loads for the embed (the
// URL widgets.js builds for a list timeline), from our server, once per CACHE_MS across all
// visitors. That also makes the tape's freshness measurable for the first time: `at` is the real
// head of the list, so `Date.now() - at` is the true age of the newest post X is serving.
//
// Every failure degrades to `{ id: null }`, which puts the client back on its plain timer.

const LIST_URL = process.env.NEXT_PUBLIC_X_LIST_URL || 'https://x.com/i/lists/2096931068477620423';
const LIST_ID = (LIST_URL.match(/lists\/(\d+)/) || [])[1] || null;
// One upstream read per CACHE_MS per serverless instance, no matter how many Terminals are open.
// Syndication's per-IP limit is tight — a sustained ~7 requests/minute from one address was enough
// to earn a 429 in testing — so this is deliberately slower than the client's poll: the browser
// asking more often costs nothing, X being asked more often costs the signal.
const CACHE_MS = 15_000;
// When an upstream read fails (429, timeout), keep answering with the last good head for this long.
// Past that we report `{ id: null }` instead: a head we cannot refresh is worse than no head at
// all, because the client would sit still waiting for an id that can no longer change, whereas a
// null puts it back on its own 60s timer.
const STALE_OK_MS = 60_000;
const TIMEOUT_MS = 6000;

// A browser-shaped request. Syndication serves the embed document to page visitors, and answers a
// bare fetch with a different (or empty) body, so the User-Agent and Referer have to look like the
// embed's own load or we would be measuring the freshness of a document nobody sees.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  referer: 'https://catalystpit.com/',
};

const EMPTY = { id: null, at: null, n: 0 };
let good = { at: 0, body: EMPTY };   // last SUCCESSFUL upstream read
let triedAt = 0;                     // last upstream attempt, successful or not

async function head() {
  if (!LIST_ID) return { id: null, at: null, n: 0 };
  const qs = new URLSearchParams({
    dnt: 'false', frame: 'false', hideBorder: 'false', hideFooter: 'true', hideHeader: 'true',
    hideScrollBar: 'false', lang: 'en', maxHeight: '560', origin: 'https://catalystpit.com/terminal',
    showHeader: 'false', theme: 'light', transparent: 'false',
    // embedId is the per-widget id widgets.js mints; a fresh one keeps every read off any cache
    // that is keyed on the full query string.
    embedId: `twitter-widget-${Math.floor(Math.random() * 1e9)}`,
  });
  const url = `https://syndication.twitter.com/srv/timeline-list/list-id/${LIST_ID}?${qs}`;

  const r = await fetch(url, { headers: HEADERS, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`syndication ${r.status}`);          // 429 lands here; caller degrades
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no timeline payload');
  const entries = JSON.parse(m[1])?.props?.pageProps?.timeline?.entries || [];
  const top = entries[0]?.content?.tweet;
  if (!top?.id_str) throw new Error('no entries');
  return { id: top.id_str, at: Date.parse(top.created_at) || null, n: entries.length };
}

const send = (body) => NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });

export async function GET() {
  const now = Date.now();
  // triedAt is stamped BEFORE the await, so a burst of concurrent requests produces one upstream
  // read, not one each. A failed read is still an attempt: backing off on failure is the whole
  // point of a per-IP rate limit, and hammering X while it is refusing us would keep it refusing.
  if (now - triedAt >= CACHE_MS) {
    triedAt = now;
    try { good = { at: now, body: await head() }; } catch { /* the last good head stands */ }
  }
  const usable = good.body.id && Date.now() - good.at <= STALE_OK_MS;
  return send(usable ? good.body : EMPTY);
}
