// HOW THE NEWS FEED TURNS ARTICLES INTO WHAT IS ON SCREEN — the filter and the layout choice,
// as pure functions so both can be tested against the real payload.
//
// ⚠️ THIS IS PRESENTATION ONLY. Ranking, materiality, High Impact classification, 8-K
// classification and headline rewriting all happen server-side and are untouched: `filterArticles`
// preserves the order it is given, and `splitHeroAndRows` chooses a CARD COMPONENT, never an
// order.

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
export function splitHeroAndRows(filtered) {
  const list = filtered || [];
  const canHero = Boolean(list[0] && list[0].imageUrl);
  return canHero ? { hero: list[0], rows: list.slice(1) } : { hero: null, rows: list };
}
