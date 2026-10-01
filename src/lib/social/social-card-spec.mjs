// THE CARD'S GEOMETRY AND TYPE SCALE. Pure, and in its own module for one practical reason: the
// renderer has to be JSX, and Node cannot import a .jsx file without a loader — so every number a test
// needs to check arithmetically lives here, where a test can simply import it.
//
// The brand values are taken from opengraph-image.jsx rather than invented: the dark green nav colour
// and the two-tone wordmark that is already the site's mark.

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1080;
export const CARD_QUALITY = 88;

export const BRAND_GREEN = '#1E5C38';
export const BRAND_ACCENT = '#5AB87A';
export const BRAND_INK = '#FFFFFF';

/**
 * How large the sentence can be set without overflowing the card.
 *
 * ⚠️ WHY THIS IS COMPUTED RATHER THAN FIXED. Satori does not report overflow — it draws what it is
 * given and silently runs past the edge — so a fixed size would publish a card with the end of the
 * headline missing, and nothing in the pipeline would notice. The size therefore falls as the line
 * grows, and the eligibility gate upstream refuses anything long enough to defeat even the smallest
 * step.
 */
export function cardFontSize(text) {
  const n = String(text ?? '').length;
  if (n <= 60) return 76;
  if (n <= 110) return 62;
  if (n <= 170) return 52;
  if (n <= 240) return 44;
  return 38;
}
