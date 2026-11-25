// ═══════════════════════════════════════════════════════════════════════════
//  VERIFY — A STORY'S PICTURE IS THE PUBLISHER'S, OR OURS, AND NEVER A GUESS
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ WHAT THIS GUARDS. fetchWire() set `image_url: null` for every press release ever ingested —
// not a filter, a hardcoded literal — so the media the issuer attached to their own release was
// parsed past and discarded. Measured on the 100 most recent stories on production, 42% of cards
// rendered a 120x80 gradient with nothing in it.
//
// Three rules, and they are not interchangeable:
//
//   RECOVERY   both feed paths must read the same fields through the same extractor, so a wire
//              item and an RSS item cannot disagree about what counts as an image.
//   HONESTY    nothing is guessed, constructed or scraped. Every candidate is a URL the publisher
//              put in their own feed next to that headline. A media:content pointing at a VIDEO is
//              not an image, and a press kit's logo JPG is not a photograph of an event.
//   COVERAGE   a card with no photograph and no company still shows something deliberate — our own
//              drawn artwork for the story's category, never an empty rectangle.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

let pass = 0; const fails = [];
const L = (s) => console.log(s);
function ok(label, cond, detail) {
  if (cond) { pass++; L(`  ok    ${label}${detail ? `  — ${detail}` : ''}`); }
  else { fails.push(label); L(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
}
const mut = (k) => (process.env.VERIFY_MUTATE || '').split(',').includes(k);

const media = code('src/lib/news-media.mjs');
const route = code('src/app/api/refresh/route.js');
const feed = code('src/components/NewsFeed.jsx');

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 1. BOTH FEED PATHS USE ONE EXTRACTOR ===');
{
  ok('⚠️ the wire path no longer hardcodes a null image',
    mut('nullimage') ? false : !/image_url: null,/.test(route));
  ok('…and extracts the publisher\'s media instead',
    /const media = extractItemImage\(item\);/.test(route));
  ok('…as does the RSS path, through the same function',
    (route.match(/extractItemImage\(item\)/g) || []).length >= 2);
  ok('…and the old three-field chain is gone',
    mut('oldchain') ? false
      : !/extractAttr\(item, 'media:content',\s*'url'\)/.test(route));
  ok('the junk-media filter has one definition, in the shared module',
    /export function isPlaceholderImage/.test(media)
      && !/^function isPlaceholderImage/m.test(route));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 2. NOTHING IS GUESSED, CONSTRUCTED OR SCRAPED ===');
{
  // ⚠️ THE EXTRACTOR MUST ONLY EVER READ. If it ever builds a URL from a domain, a slug or a
  // template, it has started inventing media — which is the one thing the brief forbids outright.
  ok('⚠️ the extractor builds no URLs, it only reads them',
    mut('construct') ? false
      : !/https?:\/\/\$\{/.test(media) && !/\+ '\/' \+/.test(media));
  ok('…and fetches nothing while parsing', !/\bfetch\(/.test(media));
  ok('⚠️ only https is accepted, because http is mixed content the browser blocks',
    mut('http') ? false : /\^https:\\\/\\\//.test(media) || /\/\^https:\\\/\\\/\/i/.test(media));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 3. AN IMAGE IS AN IMAGE, AND A LOGO IS NOT A PHOTOGRAPH ===');
{
  ok('⚠️ a media:content pointing at video or audio is refused',
    mut('anymedium') ? false
      : /medium\.toLowerCase\(\) !== 'image'/.test(media) && /!\/\^image\\\/\/i\.test\(type\)/.test(media));
  ok('…and an enclosure must declare an image type or look like one',
    /isUsableImageUrl/.test(media) && /declaredType/.test(media));

  // ⚠️ A PRESS KIT'S LOGO IS NOT AN ARTICLE PHOTOGRAPH. Business Wire's enclosures are frequently
  // the company's own mark at print resolution; stretched into a news slot that is a worse version
  // of what Logo.dev already serves. Demoted so the card falls through to the logo tier.
  ok('⚠️ a logo-ish asset is demoted rather than used as a photograph',
    mut('logoasphoto') ? false
      : /export function isLikelyLogoAsset/.test(media)
        && (route.match(/!media\.logoish/g) || []).length >= 2);
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 4. EVERY CARD SHOWS SOMETHING DELIBERATE ===');
{
  const art = code('src/components/NewsArt.jsx');
  ok('⚠️ a story with no photo and no company gets editorial artwork',
    mut('noart') ? false : /<NewsArt category=\{n\.tag\} \/>/.test(feed));
  ok('…and the card has no branch that renders an empty panel',
    mut('emptypanel') ? false : !/\) : null\}/.test(feed.slice(feed.indexOf('showImg ?'), feed.indexOf('showImg ?') + 2600)));
  ok('the artwork is drawn by us, not fetched from anywhere',
    /<svg/.test(art) && !/\bfetch\(/.test(art) && !/https?:\/\//.test(art));
  ok('…and names the category, so it reads as a topic rather than as an event photo',
    /ART_CATEGORIES/.test(art) && /LABEL\[key\]/.test(art));

  // The categories that actually occur in the live feed must each have a motif.
  const live = ['SEC', 'MARKETS', 'EARNINGS', 'M&A', 'IPO', 'RETAIL', 'POLITICS', 'AI', 'FED',
    'MACRO', 'TECH', 'GEOPOLITICS', 'PHARMA', 'ENERGY'];
  const missing = live.filter((c) => !new RegExp(`['"]?${c.replace('&', '&')}['"]?:\\s*\\(`).test(art));
  ok('⚠️ every category seen on the live feed has its own motif',
    mut('missingcat') ? false : missing.length === 0, missing.join(' ') || 'all present');
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 5. THE EXTRACTOR, AGAINST REAL FEED SHAPES ===');
{
  const { extractItemImage, isLikelyLogoAsset, isUsableImageUrl } =
    await import('../src/lib/news-media.mjs');

  const item = (inner) => `<item><title>t</title><link>https://x.test/a</link>${inner}</item>`;

  ok('media:content is taken',
    extractItemImage(item('<media:content url="https://cdn.test/a.jpg" type="image/jpeg"/>'))?.field === 'media:content');
  ok('an enclosure is taken when media is absent',
    extractItemImage(item('<enclosure url="https://cdn.test/b.png" type="image/png"/>'))?.field === 'enclosure');
  ok('⚠️ a VIDEO media:content is refused',
    extractItemImage(item('<media:content url="https://cdn.test/v.mp4" type="video/mp4"/>')) === null);
  ok('⚠️ an http URL is refused as mixed content',
    extractItemImage(item('<media:content url="http://cdn.test/a.jpg" type="image/jpeg"/>')) === null);
  ok('a stock-agency frame is refused',
    extractItemImage(item('<media:content url="https://gettyimages.com/a.jpg" type="image/jpeg"/>')) === null);
  ok('an image embedded in description is found when nothing better exists',
    extractItemImage(item('<description>&lt;p&gt;&lt;img src="https://cdn.test/c.jpg"&gt;</description>'))?.field === 'description');
  ok('an item with no media at all yields null', extractItemImage(item('<description>words</description>')) === null);
  ok('⚠️ a press-kit logo is flagged', isLikelyLogoAsset('https://mms.businesswire.com/x/PP_LOGO_2.5_INCH_For_Docs.jpg'));
  ok('…and an ordinary photograph is not', !isLikelyLogoAsset('https://mmx.prnewswire.com/media/261105_Method_04_025-1.jpg'));
  ok('a bare domain is not an image', !isUsableImageUrl('https://example.com/'));

  // ── ⚠️ THE THREE HOLES THAT SHIPPED, EACH MEASURED IN A REAL BROWSER AFTER DEPLOY ──────────
  //
  // The first version trusted a publisher's `type="image/…"` outright. That is NECESSARY for WSJ
  // and MarketWatch, whose URLs are extensionless and identifiable no other way — and it is what
  // let an .mp4 and a YouTube watch page onto cards. 14 of 42 images were broken.
  ok('⚠️ an extensionless URL with a declared image type is still accepted (WSJ, MarketWatch)',
    mut('notrust') ? false
      : isUsableImageUrl('https://images.wsj.net/im-88976063', { declaredType: 'image/jpeg' }));
  ok('⚠️ …but a .mp4 is refused even when the feed labels it an image',
    mut('mp4') ? false
      : !isUsableImageUrl('https://mmx.prnewswire.com/media/X/a.mp4?id=1', { declaredType: 'image/jpeg' }));
  ok('⚠️ …and a YouTube watch page is refused however it is typed',
    mut('youtube') ? false
      : !isUsableImageUrl('https://www.youtube.com/watch?v=tr3GKYH2YGE', { declaredType: 'image/jpeg' }));
  ok('⚠️ …and Business Wire media is refused, because it 403s to everyone',
    mut('bwhost') ? false
      : !isUsableImageUrl('https://mms.businesswire.com/media/2026/en/1/21/Ingles_Market_2020.jpg',
        { declaredType: 'image/jpeg' }));
  ok('…while PR Newswire photographs still pass',
    isUsableImageUrl('https://mmx.prnewswire.com/media/MS2043004/261105_Method_04_025-1.jpg?id=OA3100874',
      { declaredType: 'image/jpeg' }));
}

L(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { L('FAILED:'); fails.forEach((f) => L('  - ' + f)); process.exit(1); }
L('EVERY NEWS MEDIA CHECK PASSED');
