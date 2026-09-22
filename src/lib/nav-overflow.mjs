// HOW MANY NAV ITEMS FIT IN THE WIDTH THE NAV ACTUALLY HAS.
//
// ⚠️ A SEPARATE MODULE SO THE BEHAVIOUR CAN BE TESTED. cp-shared.jsx cannot be imported by a node
// suite, and the header cannot be laid out in one either — so inlined, the only assertion
// available would be a regex over the component's source. This session has already produced three
// assertions that passed while the bug was live because they matched source text rather than
// behaviour. Pure arithmetic over measured widths is testable at the exact container widths the
// docks produce.
//
// ⚠️ THE INPUT IS CONTAINER WIDTH, NOT VIEWPORT WIDTH, AND THAT IS THE WHOLE POINT. The header
// sits inside #cp-shell, which is inset by --cp-tape / --cp-pit / --cp-watch (330px per open
// dock). With two docks open on a 1920px monitor the viewport is still 1920 while the header has
// 1260 — which is why every existing `@media (max-width: 860px)` rule never fired and the nav
// clipped Politicians and Institutions instead of adapting.

/**
 * @param {number[]} widths natural width of each nav item, in order
 * @param {number}   avail  the container's client width
 * @param {number}   moreW  natural width of the "More" control
 * @param {number}   gap    flex gap between items
 * @returns {number} how many leading items to render inline; the rest go to the overflow menu
 */
export function fitCount(widths, avail, moreW, gap = 16) {
  if (!Array.isArray(widths) || widths.length === 0) return 0;
  // Unmeasured (SSR, or before the first ResizeObserver callback): show everything rather than
  // hide it. Guessing low here would flash a "More" menu on a wide screen that never needed one.
  if (!(avail > 0)) return widths.length;

  // Everything fits, so no More control exists and none of its width is reserved. Reserving it
  // unconditionally is what makes the last item oscillate in and out at the boundary.
  const total = widths.reduce((s, w) => s + w, 0) + gap * (widths.length - 1);
  if (total <= avail) return widths.length;

  let used = moreW + gap, n = 0;
  for (const w of widths) {
    if (used + w > avail) break;
    used += w + gap;
    n += 1;
  }
  // ⚠️ NEVER ZERO. A nav that collapses entirely into "More" reads as a broken header; one real
  // destination always stays visible and the rest are one click away.
  return Math.max(1, n);
}
