// ── WHAT PICTURE, IF ANY, A FEED ITEM ACTUALLY CARRIES ─────────────────────
//
// ⚠️ MEASURED ON THE LIVE FEEDS BEFORE A LINE OF THIS WAS WRITTEN, because the previous version was
// written against an assumption and that is exactly how the hole appeared. fetchWire() set
// `image_url: null` for EVERY press release — not as a filter, as a hardcoded literal — and
// fetchRSS() looked at three fields and stopped. Fetched 2026-11-25:
//
//   PR Newswire     20 items, media:content on 15   → real article photographs on mmx.prnewswire.com
//   Business Wire   21 items, enclosure     on 18   → publisher media, frequently the company's logo
//   WSJ             61 items, media:content on 53   → already captured
//   MarketWatch     10 items, media:content on 10   → already captured
//   Bloomberg       20 items, NO image tags at all  → nothing to recover, at any effort
//   GlobeNewswire   HTTP 403                        → the feed itself is refusing us
//
// So 33 of the 41 wire stories on the page had a publisher-provided image sitting in the XML that
// we parsed past. Measured effect on the 100 most recent: 42% of cards rendered a bare gradient.
//
// ⚠️ NOTHING HERE GUESSES, SCRAPES OR CONSTRUCTS A URL. Every candidate is a URL the publisher put
// in their own feed, for that item, next to that headline. An image we cannot find is an absence to
// be handled by the card, never a reason to go looking on somebody's website.

/**
 * Publisher assets we deliberately refuse: generic share-cards, tracking pixels, stock-agency
 * watermarked frames, and CDNs whose output is uniformly unusable. Moved here from the refresh
 * route so the wire path and the RSS path cannot disagree about what counts as junk.
 */
export function isPlaceholderImage(url) {
  if (!url || typeof url !== 'string') return true;
  const u = url.toLowerCase();
  // Yahoo Finance generic placeholders (exact + pattern)
  if (u.includes('yahoo_finance_en-us_h_p_finance')) return true;
  if (u.includes('s.yimg.com/rz/stage/')) return true;
  if (u.includes('s.yimg.com/cv/apiv2/default')) return true;
  if (u.includes('s.yimg.com/os/creatr-uploaded-images/finance')) return true;
  if (u.match(/s\.yimg\.com.*\/api\/res\/.*\/finance/)) return true;
  // Generic share-images known to be placeholders
  if (u.includes('default-share-image')) return true;
  if (u.includes('logo-placeholder')) return true;
  if (u.includes('default_thumbnail')) return true;
  if (u.includes('default-image')) return true;
  if (u.includes('og-default')) return true;
  // Tiny images (often placeholders / icons)
  if (u.match(/\b(1x1|pixel|spacer|blank)\.(gif|png|jpg)\b/)) return true;
  // Stock photo agencies — common in API-republished wire stories
  if (u.includes('gettyimages')) return true;
  if (u.includes('istockphoto')) return true;
  if (u.includes('shutterstock')) return true;
  if (u.includes('dreamstime')) return true;
  if (u.includes('123rf')) return true;
  if (u.includes('alamy')) return true;
  if (u.includes('depositphotos')) return true;
  // SeekingAlpha CDN — images uniformly low quality
  if (u.includes('seekingalpha')) return true;
  return false;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;

/**
 * Is this a URL we are willing to put in an <img> on a card?
 *
 * ⚠️ https ONLY, AND THAT IS NOT PEDANTRY. The site is served over https, so an http image is
 * mixed content the browser blocks — it would render as the broken tile this work exists to remove.
 */
export function isUsableImageUrl(url, { declaredType = '' } = {}) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!/^https:\/\//i.test(u)) return false;
  if (isPlaceholderImage(u)) return false;
  // Either the publisher declared an image MIME type, or the URL looks like an image file.
  if (/^image\//i.test(declaredType)) return true;
  return IMAGE_EXT.test(u);
}

/**
 * ⚠️ A WIRE "IMAGE" IS OFTEN THE COMPANY'S LOGO, AND WE HAVE A BETTER ONE OF THOSE.
 *
 * Business Wire's enclosure for the first item measured was
 * `.../PP_LOGO_2.5_INCH_For_Docs.jpg` — Perma-Pipe's logo, supplied at print resolution for a
 * press kit. Stretched into a 120x80 news slot it reads as a worse version of the mark Logo.dev
 * already serves cleanly, so an asset that SAYS it is a logo is demoted rather than used as a
 * photograph. The card then falls through to the Logo.dev tier, which is the right picture.
 *
 * This matches on the filename only. It is deliberately conservative: a photograph that merely
 * happens to contain the word "logo" in a path segment is rare, and the cost of a false positive
 * is one card showing a clean vector logo instead of a press-kit JPG of the same logo.
 */
export function isLikelyLogoAsset(url) {
  if (!url || typeof url !== 'string') return false;
  const file = url.split('?')[0].split('/').pop() || '';
  return /(^|[-_.])logos?([-_.]|\d|$)/i.test(file);
}

const attr = (xml, tag, name) => {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`, 'i').exec(xml);
  return m ? m[1] : null;
};
const unescapeXml = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

/**
 * The best publisher-provided image for one feed `<item>`, or null.
 *
 * Order is by how specific the field is about being THE image for THIS story:
 *   media:content   the enclosure-equivalent in Media RSS, what WSJ, MarketWatch and PR Newswire use
 *   media:thumbnail an explicit thumbnail
 *   enclosure       RSS 2.0's attachment, what Business Wire uses
 *   embedded <img>  the first image inside content:encoded or description — last, because an
 *                   article body can contain a tracking pixel or a publisher's own furniture
 *
 * @param {string} itemXml one <item>…</item>
 * @returns {{url: string, field: string, logoish: boolean}|null}
 */
export function extractItemImage(itemXml) {
  if (!itemXml || typeof itemXml !== 'string') return null;

  const candidates = [];
  // media:content and media:thumbnail may both appear, and media:content may repeat; take them in
  // document order so the publisher's own preference wins.
  for (const m of itemXml.matchAll(/<media:(content|thumbnail)\b[^>]*>/gi)) {
    const tagXml = m[0];
    const url = /\burl="([^"]*)"/i.exec(tagXml)?.[1];
    const type = /\btype="([^"]*)"/i.exec(tagXml)?.[1] || '';
    const medium = /\bmedium="([^"]*)"/i.exec(tagXml)?.[1] || '';
    // ⚠️ A media:content CAN BE A VIDEO OR AUDIO. Only take it when it says image, or says nothing
    // and the URL looks like one.
    if (medium && medium.toLowerCase() !== 'image') continue;
    if (type && !/^image\//i.test(type)) continue;
    if (url) candidates.push({ url: unescapeXml(url), field: `media:${m[1].toLowerCase()}`, type });
  }

  const encUrl = attr(itemXml, 'enclosure', 'url');
  if (encUrl) {
    const encType = attr(itemXml, 'enclosure', 'type') || '';
    if (!encType || /^image\//i.test(encType)) {
      candidates.push({ url: unescapeXml(encUrl), field: 'enclosure', type: encType });
    }
  }

  // Embedded HTML, last. content:encoded first, then description.
  for (const tag of ['content:encoded', 'description']) {
    const body = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(itemXml)?.[1];
    if (!body) continue;
    const html = unescapeXml(body.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1'));
    const src = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(html)?.[1];
    if (src) candidates.push({ url: unescapeXml(src), field: tag, type: '' });
  }

  for (const c of candidates) {
    if (isUsableImageUrl(c.url, { declaredType: c.type })) {
      return { url: c.url, field: c.field, logoish: isLikelyLogoAsset(c.url) };
    }
  }
  return null;
}
