/**
 * ⚠️ THE DIFFERENCE BETWEEN "ZERO" AND "WE DO NOT KNOW", kept in a module with no imports so it can
 * be executed by a test rather than only read.
 *
 * cp-shared's safeN returns 0 for anything unparseable. That is the right answer for a width, a
 * count or a sort key, and the wrong answer for a market figure: a missing percentage change became
 * a hard 0, which renders as a real, flat 0.00% — and red, because chgC treats 0 as not-positive.
 * Every ticker on the homepage tape read 0.00% that way while the market had moved percent.
 *
 * The values are not interchangeable. A stock that genuinely closed unchanged IS 0.00% and that is
 * information worth showing; a stock whose change we could not establish is a dash. Collapsing the
 * second into the first destroys the only value that should ever render as zero.
 */

/** Parse to a number, or null when there is nothing to parse. Zero survives as zero. */
export const maybeN = (v) => {
  const x = parseFloat(v);
  return Number.isNaN(x) ? null : x;
};
