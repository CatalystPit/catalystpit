import 'server-only';

// THE INSTAGRAM CARD: rendered from the canonical sentence, converted to JPEG, hosted publicly.
//
// WHY THIS FILE HAS TO EXIST AT ALL. Instagram has no text-only post, and the Graph API does not
// accept an upload — it takes an `image_url` and cURLs it ITSELF, from Meta's own servers. So a post
// needs two things we did not have: a JPEG, and a URL that a machine outside our network can fetch.
//
// WHAT WAS VERIFIED RATHER THAN ASSUMED, because the brief is right that this is where fabrication
// creeps in:
//
//   next/og's ImageResponse HAS NO FORMAT OPTION. Its options type is width/height/debug/fonts/emoji
//   and nothing else; output is PNG. Instagram's documented requirement is JPEG. So a conversion step
//   is not a preference, it is the only way the two meet.
//
//   sharp DOES the conversion and is present — but only as an undeclared transitive dependency of
//   Next, which is not something to build a publishing path on: a Next upgrade could drop it and the
//   failure would appear as "Instagram stopped posting". It is therefore declared in package.json by
//   this change, and imported lazily so that a missing binary degrades to "no card" rather than
//   breaking the module graph for Threads, which needs none of this.
//
//   THE URL MUST BE PUBLIC, and a private or localhost URL is the classic silent failure here: Meta
//   returns a generic media error and the real cause is that it could not reach the file. @vercel/blob
//   with `access: 'public'` is the hosting we already use for user uploads, so it is a known-good
//   path rather than new infrastructure — and `addRandomSuffix` means the only thing exposed is the
//   one asset being published, at an unguessable path, rather than an enumerable directory of cards.
//
// NOTHING HERE PUBLISHES. It produces a validated media descriptor or it produces null with a reason.

import { ImageResponse } from 'next/og';
import { validateInstagramImage, isPublicMediaUrl } from './instagram-post.mjs';
import { CARD_WIDTH, CARD_HEIGHT, CARD_QUALITY, BRAND_GREEN, BRAND_ACCENT, BRAND_INK,
  cardFontSize } from './social-card-spec.mjs';

// Square. Inside Instagram's 0.8–1.91 aspect window with the widest margin on both sides, and inside
// the 320–1440 width range — so a rounding difference in a renderer cannot push it out of spec.
// The geometry, the type scale and the brand values live in a pure module so a test can import the
// numbers directly: Node cannot load a .jsx file without a loader, and a suite forced to parse this
// file to check its arithmetic would be checking a regex rather than a value.
export { CARD_WIDTH, CARD_HEIGHT, CARD_QUALITY, cardFontSize };

// No new mark, no stock photography, and - by instruction - no source name on the graphic:
// provenance belongs in the product, where it is a link and a record, not on an image.
const GREEN = BRAND_GREEN;
const ACCENT = BRAND_ACCENT;
const INK = BRAND_INK;

/** The card as React elements. Exported so a test can assert its content without rendering a PNG. */
export function cardElement({ headline, tickers = [] }) {
  const line = String(headline ?? '').trim();
  const tags = (Array.isArray(tickers) ? tickers : []).filter(Boolean).slice(0, 3);
  const size = cardFontSize(line);
  return (
    <div
      style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        justifyContent: 'space-between', background: GREEN, padding: '84px 76px',
        fontFamily: 'Georgia, "Times New Roman", serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline' }}>
        <span style={{ fontSize: 46, color: INK, letterSpacing: '-0.02em' }}>Catalyst</span>
        <span style={{ fontSize: 46, color: ACCENT, fontStyle: 'italic', fontWeight: 700, letterSpacing: '-0.02em' }}>Pit</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'center' }}>
        <div style={{ fontSize: size, color: INK, lineHeight: 1.22, letterSpacing: '-0.01em' }}>{line}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        {tags.map((t) => (
          <span key={t} style={{ fontSize: 34, color: ACCENT, fontFamily: 'Georgia, serif' }}>${t}</span>
        ))}
      </div>
    </div>
  );
}

/** Render the card to a PNG buffer. Separated so the conversion step can be tested on its own. */
export async function renderCardPng({ headline, tickers = [] }) {
  const res = new ImageResponse(cardElement({ headline, tickers }), {
    width: CARD_WIDTH, height: CARD_HEIGHT,
  });
  return Buffer.from(await res.arrayBuffer());
}

/**
 * PNG to JPEG. Lazily imported, and a missing binary is reported rather than thrown: Threads shares
 * this module's directory but none of its requirements, and an import-time failure here would take a
 * working text channel down with an image dependency it does not use.
 */
export async function pngToJpeg(png) {
  let sharp;
  try { ({ default: sharp } = await import('sharp')); }
  catch { return { ok: false, reason: 'jpeg encoder unavailable' }; }
  try {
    // flatten onto the brand green: a JPEG has no alpha channel, and an unflattened transparent pixel
    // becomes black rather than the card's background.
    const jpeg = await sharp(png)
      .flatten({ background: GREEN })
      .toColourspace('srgb')          // Instagram's documented colour space
      .jpeg({ quality: CARD_QUALITY, mozjpeg: true })
      .toBuffer();
    return { ok: true, jpeg };
  } catch (e) {
    return { ok: false, reason: `jpeg encode failed: ${String(e?.message || e).slice(0, 80)}` };
  }
}

/**
 * Render, convert, validate against Meta's rules, and host. Returns a media descriptor the publisher
 * can hand to the Graph API, or { ok: false, reason } — and the reason is always something an operator
 * can act on, never a stack trace.
 *
 * VALIDATION HAPPENS BEFORE UPLOAD. There is no point hosting a file Instagram will refuse, and a
 * rejected upload leaves a public URL behind for nothing.
 */
export async function buildInstagramCard({ headline, tickers = [], eventSeq, blobToken = process.env.BLOB_READ_WRITE_TOKEN }) {
  if (!String(headline ?? '').trim()) return { ok: false, reason: 'no headline to render' };
  // Checked first: without a media host there is no publishable card, and saying so is more useful
  // than rendering an image that cannot go anywhere.
  if (!blobToken) return { ok: false, reason: 'media host not configured (BLOB_READ_WRITE_TOKEN)' };

  let png;
  try { png = await renderCardPng({ headline, tickers }); }
  catch (e) { return { ok: false, reason: `card render failed: ${String(e?.message || e).slice(0, 80)}` }; }

  const conv = await pngToJpeg(png);
  if (!conv.ok) return { ok: false, reason: conv.reason };

  const descriptor = {
    contentType: 'image/jpeg', bytes: conv.jpeg.length, width: CARD_WIDTH, height: CARD_HEIGHT,
  };
  const v = validateInstagramImage(descriptor);
  if (!v.ok) return { ok: false, reason: `card fails Instagram media rules: ${v.problems.join('; ')}` };

  let url;
  try {
    const { put } = await import('@vercel/blob');
    // addRandomSuffix: the published asset is reachable and nothing else is. A predictable path would
    // make every card we have ever rendered enumerable from one example.
    const blob = await put(`social/ig/${eventSeq ?? 'card'}.jpg`, conv.jpeg, {
      access: 'public', contentType: 'image/jpeg', addRandomSuffix: true, token: blobToken,
    });
    url = blob.url;
  } catch (e) {
    return { ok: false, reason: `media upload failed: ${String(e?.message || e).slice(0, 80)}` };
  }

  // The last gate, and not a formality: Meta fetches this URL from outside our network, so a
  // non-public result here would surface as an opaque Instagram media error with no stated cause.
  if (!isPublicMediaUrl(url)) return { ok: false, reason: 'hosted card url is not publicly fetchable' };

  return { ok: true, image: { url, ...descriptor } };
}
