// HOW THE NEWS FEED TURNS ARTICLES INTO WHAT IS ON SCREEN — the filter and the layout choice,
// as pure functions so both can be tested against the real payload.
//
// ⚠️ THIS IS PRESENTATION ONLY. Ranking, materiality, High Impact classification, 8-K
// classification and headline rewriting all happen server-side and are untouched: `filterArticles`
// preserves the order it is given, and `splitHeroAndRows` chooses a CARD COMPONENT, never an
// order.

import { minsSince, isoOrNull } from './home-model.mjs';

/**
 * The one ticker-filter implementation.
 *
 * ⚠️ ONE FUNCTION, SO THE TYPED SEARCH AND THE TRENDING CHIPS CANNOT DIVERGE. They set the same
 * state and therefore run this same predicate; a second implementation is how they would drift.
 *
 * The ticker match is a substring so that typing "NV" progressively narrows while typing, which is
 * what the input is for. A Trending chip passes the whole symbol, so it lands on an exact match.
 */
export function filterArticles(articles, {
  category = 'ALL', ticker = '', hiddenSources = new Set(), impactOnly = false, impactOf = null,
} = {}) {
  const q = String(ticker || '').trim().toUpperCase();
  return (articles || []).filter((a) => {
    if (category !== 'ALL' && a.tag !== category) return false;
    if (q && (!a.sym || !String(a.sym).toUpperCase().includes(q))) return false;
    if (a.source && hiddenSources.has(a.source)) return false;
    if (impactOnly && impactOf
      && impactOf({ title: a.headline, category: a.tag, source: a.source, ticker: a.sym }) === 'routine') return false;
    return true;
  });
}

/**
 * WHICH STORY MAY OCCUPY THE HERO SLOT — and this is the bug that made ticker filtering look broken.
 *
 * ⚠️ THE HERO IS A PHOTO CARD. NewsPhotoCard renders a 340px image panel with the headline
 * overlaid on it. Given a story with no image it draws an empty gradient block, which is fine as
 * one card among many and is the entire results area when a filter matches a single story.
 *
 * The feed promoted `filtered[0]` into that slot unconditionally. Unfiltered, the first story is
 * normally a curated one WITH a photo, so nothing looked wrong. Filter to a ticker whose only
 * story is an SEC 8-K — every one of which has `imageUrl: null`, measured on the live payload —
 * and the page showed a tall blank panel instead of the event the user had just clicked. It was
 * never a filtering failure: the story matched, and the hero could not draw it.
 *
 * So the hero is now offered only a story that can fill it. Everything else renders as a row,
 * which is the card that already handles a missing image by showing the ticker's logo — the same
 * way these 8-Ks appear in the unfiltered feed.
 *
 * ⚠️ THE ORDER IS UNTOUCHED. When the first story has no photo it becomes the first ROW rather
 * than being dropped or reordered; nothing is hidden and nothing is promoted past anything else.
 */
/**
 * THE LOCKED-STORIES CALL TO ACTION.
 *
 * ⚠️ `lockedCount` DESCRIBES THE WHOLE FEED, NOT THE FILTERED VIEW. The server sends one number
 * for everything a signed-out visitor is not receiving — measured, 84 while six stories are shown.
 * Rendering it under a ticker filter said "Sign in to see all 84 stories" directly beneath a
 * single FDCT result, which reads as a promise of 84 FDCT stories. There are not 84; there is one.
 *
 * ⚠️ AND THE HONEST FIX IS TO DROP THE NUMBER, NOT TO RECOUNT. A per-ticker locked count does not
 * exist in the payload and inventing one would mean another query for a line of copy. So a
 * filtered view states the truth it can afford — that there is more behind sign-in — and only the
 * unfiltered view, where the number genuinely describes what is being hidden, quotes it.
 */
export function lockedCtaText(lockedCount, { tickerFiltered = false } = {}) {
  const n = Number(lockedCount) || 0;
  if (n <= 0) return null;
  if (tickerFiltered) return 'Sign in to see more news';
  return `Sign in to see all ${n} ${n === 1 ? 'story' : 'stories'}`;
}

export function splitHeroAndRows(filtered) {
  const list = filtered || [];
  const canHero = Boolean(list[0] && list[0].imageUrl);
  return canHero ? { hero: list[0], rows: list.slice(1) } : { hero: null, rows: list };
}

// ── ⚠️ THE ARTICLE SHAPE, MOVED HERE BECAUSE THE SERVER NOW BUILDS IT TOO ───────────────────
//
// This mapping lived inside NewsFeed's own `fetchNews`, which was fine while the browser was the
// only thing that ever built it. app/news/page.jsx now renders the river at generation time, so
// the shape has to exist outside a client component — and it has to be the SAME shape, because
// React hydrates the server's HTML against the browser's first render of these exact objects.
//
// ⚠️ `now` IS A PARAMETER, AND THAT IS THE WHOLE REASON THIS IS PURE. `mins` is an AGE, so
// computing it twice against two different clocks is a guaranteed hydration mismatch — the server
// says 4m, the browser says 5m, React throws the server's HTML away and the crawler's copy of the
// page is the one nobody checked. The server captures one instant, passes the normalized objects
// through as props, and the browser's first render reuses those numbers verbatim. The 15-minute
// refresh effect then recomputes against the browser's own clock, which is correct: by then it is
// a re-render, not a hydration.
//
// ⚠️ `published` IS NEW AND IS NOT A DISPLAY FIELD. It is the absolute instant the age was derived
// from, kept so a dated <time datetime="…"> can be emitted beside the human "4m ago". An age alone
// is unreadable to anything that did not fetch the page at that moment.

/**
 * Normalize a river of stories into the display shape NewsFeed renders.
 *
 * @param {object[]} stories  the composed river (see lib/news-river.mjs)
 * @param {object}   [opts]
 * @param {number}   [opts.now] the clock every age is measured from
 * @returns {object[]} display-shaped articles, headline-less rows dropped
 */
export function normalizeArticles(stories, { now = Date.now() } = {}) {
  return (Array.isArray(stories) ? stories : []).map((s) => ({
    headline: s.title || s.headline || s.summary || s.description || '',
    source: s.source || s.outlet || s.publisher || 'Market News',
    mins: minsSince(s.published || s.published_at || s.date || s.pubDate, now),
    published: isoOrNull(s.published || s.published_at || s.date || s.pubDate),
    tag: (s.category || s.tag || s.sector || 'MARKETS').toUpperCase(),
    sym: (s.ticker && s.ticker !== 'N/A' && s.ticker !== 'null') ? s.ticker : (s.symbol || s.sym || null),
    summary: s.summary || s.description || '',
    imageUrl: s.image_url || s.imageUrl || s.image || s.thumbnail || s.photo_url || null,
    url: s.url || null,
  })).filter((a) => a.headline);
}
