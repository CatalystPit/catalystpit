// GOOGLE ADSENSE SITE VERIFICATION.
//
//   node scripts/verify-adsense.mjs                                  (the source and the built HTML)
//   CP_ADSENSE_LIVE=https://catalystpit.com node scripts/verify-adsense.mjs   (+ the deployed site)
//
// ⚠️ WHAT ACTUALLY HAS TO BE TRUE. Google's verification crawler reads the SERVED HTML. It is not
// enough for the tag to exist in a component: it has to survive into the document Next renders, which
// rules out next/script's afterInteractive (injected from the client bundle after hydration) and makes
// beforeInteractive the only next/script option that lands in the HTML — and that one blocks rendering.
// So this asserts the tag in the source, in the BUILT output, and on the live site, because those are
// three different claims and only the last one is the one Google checks.
//
// It also asserts the things that would make this an AD PLACEMENT rather than a verification tag,
// because that is the line this change is not supposed to cross.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const CLIENT = 'ca-pub-8341744464373905';

/**
 * How many actual <script> ELEMENTS load Google's ad host in this document.
 *
 * ⚠️ NOT A COUNT OF THE PUBLISHER ID, AND THE DIFFERENCE MATTERS. The id appears TWICE in every
 * rendered page, and only one of them is a script. The second sits inside the RSC flight payload — the
 * serialized React tree Next embeds so the client can hydrate — as
 * `["$","script",null,{"async":true,"src":"…","crossOrigin":"anonymous"}]`. That is a description of the
 * element, not a second element, and it causes no second request. Counting occurrences of the id
 * reported "23 pages with a duplicate" for a document carrying exactly one loader.
 */
const scriptTagCount = (html) => (html.match(/<script[^>]*pagead2\.googlesyndication\.com[^>]*>/g) || []).length;
const HOST = 'pagead2.googlesyndication.com';
const SCRIPT_PATH = '/pagead/js/adsbygoogle.js';

// ── 1. the tag is in the root layout, exactly once ─────────────────────────────────────────────
console.log('\n1. the tag is in the root layout, exactly once');

const layout = read('src/app/layout.jsx');
ok('the publisher id is declared', layout.includes(`const ADSENSE_CLIENT = '${CLIENT}'`));
ok('...and the loader points at Google\'s host', layout.includes(`https://${HOST}${SCRIPT_PATH}?client=`));
ok('the script is rendered in the root layout', /<script async src=\{ADSENSE_SRC\} crossOrigin="anonymous" \/>/.test(layout));
// ⚠️ ONCE PER DOCUMENT. Two loaders is a policy problem as well as a wasted request.
ok('⚠️ the publisher id appears exactly once in the layout',
  (layout.match(new RegExp(CLIENT, 'g')) || []).length === 1,
  `${(layout.match(new RegExp(CLIENT, 'g')) || []).length} occurrences`);
ok('...and the loader is rendered exactly once',
  (layout.match(/ADSENSE_SRC/g) || []).length === 2,   // the constant, and the one use
  `${(layout.match(/ADSENSE_SRC/g) || []).length}`);

// ── 2. it is in <head>, async, and not blocking ────────────────────────────────────────────────
console.log('\n2. it is in <head>, async, and not blocking');

const headStart = layout.indexOf('<head>');
const headEnd = layout.indexOf('</head>');
const tagAt = layout.indexOf('src={ADSENSE_SRC}');
ok('the head is where it sits', headStart > 0 && headEnd > headStart && tagAt > headStart && tagAt < headEnd);
ok('⚠️ it is async, so it cannot block first paint', /<script async src=\{ADSENSE_SRC\}/.test(layout));
ok('it carries crossOrigin="anonymous", as Google\'s snippet does',
  /src=\{ADSENSE_SRC\} crossOrigin="anonymous"/.test(layout));
// ⚠️ NOT next/script. afterInteractive would not reach the served HTML; beforeInteractive would block.
ok('⚠️ it is a plain tag, not next/script', !/from 'next\/script'/.test(layout) && !/<Script/.test(layout));
ok('...and nothing else in the app imports next/script for this',
  !/googlesyndication/.test(read('src/app/page.jsx') || ''));

// ── 3. it is verification, NOT an ad placement ─────────────────────────────────────────────────
console.log('\n3. it is verification, not an ad placement');

// ⚠️ THE LINE THIS CHANGE MUST NOT CROSS. A verification loader declares no slot, reserves no space
// and pushes nothing. Any of these appearing would mean ads are actually running.
const all = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { walk(rel); continue; }
    if (/\.(jsx?|mjs|tsx?)$/.test(e.name)) all.push(rel);
  }
};
walk('src');
const offenders = { ins: [], push: [], autoAds: [] };
for (const f of all) {
  const src = read(f);
  if (/<ins\b|adsbygoogle-?ins|className="adsbygoogle"/.test(src)) offenders.ins.push(f);
  if (/adsbygoogle\s*\)\s*\.push|adsbygoogle\.push/.test(src)) offenders.push.push(f);
  if (/enable_page_level_ads|data-ad-client|data-ad-slot/.test(src)) offenders.autoAds.push(f);
}
ok('⚠️ no ad unit is declared anywhere', offenders.ins.length === 0, offenders.ins.join(', '));
ok('⚠️ nothing pushes to the adsbygoogle queue', offenders.push.length === 0, offenders.push.join(', '));
ok('⚠️ Auto Ads / slot attributes appear nowhere', offenders.autoAds.length === 0, offenders.autoAds.join(', '));
// Only the root layout references Google's ad host at all.
const refs = all.filter((f) => read(f).includes(HOST));
ok('⚠️ exactly one file references Google\'s ad host',
  refs.length === 1 && refs[0] === 'src/app/layout.jsx', refs.join(', '));

// ── 4. nothing else in the head moved ──────────────────────────────────────────────────────────
console.log('\n4. nothing else in the head moved');

// ⚠️ PRESENT *AND* FIRST. `indexOf` returns -1 for something absent, and -1 is less than any index — so
// the ordering test alone passed when the theme script had been deleted outright, which is a worse
// outcome than the wrong order. Existence is asserted before position.
const themeAt = layout.indexOf("localStorage.getItem('cp_theme')");
ok('the pre-paint theme script is still there', themeAt > 0);
ok('...and still runs before the ad loader, so the theme cannot flash',
  themeAt > 0 && themeAt < tagAt, `theme@${themeAt} adsense@${tagAt}`);
ok('both ld+json blocks are still emitted server-side',
  (layout.match(/type="application\/ld\+json"/g) || []).length === 2);
ok('the font preconnects and stylesheet are intact',
  layout.includes('rel="preconnect" href="https://fonts.googleapis.com"')
  && layout.includes('fonts.googleapis.com/css2?family=Cormorant'));
ok('Clerk still wraps the tree', /<ClerkProvider>/.test(layout));
ok('suppressHydrationWarning is still on <html>', /<html lang="en" suppressHydrationWarning>/.test(layout));

// ── 5. the BUILT html, not just the source ─────────────────────────────────────────────────────
console.log('\n5. the built html, not just the source');

// ⚠️ A COMPONENT CONTAINING THE TAG IS NOT THE SAME CLAIM AS A DOCUMENT CONTAINING IT. Next prerenders
// the static routes to .next/server/app/*.html; if the tag did not survive rendering, it is not there.
const builtDir = path.join(ROOT, '.next/server/app');
if (fs.existsSync(builtDir)) {
  const htmls = fs.readdirSync(builtDir).filter((f) => f.endsWith('.html'));
  ok('the build produced prerendered html to inspect', htmls.length > 0, `${htmls.length} files`);
  let withTag = 0, dupes = 0;
  for (const f of htmls) {
    const html = fs.readFileSync(path.join(builtDir, f), 'utf8');
    const n = scriptTagCount(html);
    if (n > 0) withTag += 1;
    if (n > 1) dupes += 1;
  }
  ok('⚠️ every prerendered page carries the publisher id', withTag === htmls.length,
    `${withTag}/${htmls.length}`);
  ok('⚠️ ...and none carries a second loader', dupes === 0, `${dupes} pages with a duplicate`);
  const sample = fs.readFileSync(path.join(builtDir, htmls[0]), 'utf8');
  ok('the built tag loads from Google\'s host', sample.includes(`${HOST}${SCRIPT_PATH}?client=${CLIENT}`));
  // ⚠️ REACT RENDERS A BOOLEAN ATTRIBUTE AS async="", so Google's own spelling of the snippet is not
  // what lands in the document. Matching the snippet literally failed on correct output.
  ok('...is async', /<script async(?:="")? src="https:\/\/pagead2\.googlesyndication\.com/.test(sample),
    (sample.match(/<script[^>]*googlesyndication[^>]*>/) || [''])[0].slice(0, 140));
  ok('...and carries crossorigin="anonymous" in the rendered html',
    /pagead2\.googlesyndication\.com[^>]*crossorigin="anonymous"/.test(sample)
    || /crossorigin="anonymous"[^>]*pagead2\.googlesyndication\.com/.test(sample));
  ok('...inside the document head', sample.indexOf(CLIENT) < sample.indexOf('</head>'));
} else {
  console.log('  (no .next build found — run `next build` first to check the rendered html)');
}

// ── 6. the DEPLOYED site, which is the only claim Google checks ─────────────────────────────────
const LIVE = process.env.CP_ADSENSE_LIVE || null;
console.log(`\n6. the deployed site ${LIVE ? `(${LIVE})` : '(skipped — set CP_ADSENSE_LIVE)'}`);

if (LIVE) {
  // Several routes, not one: the tag is in the root layout, so every page must carry it.
  for (const route of ['/', '/fear-greed', '/ticker/AAPL', '/terminal', '/privacy']) {
    let html = null;
    try {
      const r = await fetch(`${LIVE}${route}`, { cache: 'no-store', redirect: 'follow' });
      html = r.ok ? await r.text() : null;
      ok(`${route} responds`, r.ok, `HTTP ${r.status}`);
    } catch (e) { ok(`${route} responds`, false, e.message); }
    if (!html) continue;
    const n = scriptTagCount(html);
    ok(`⚠️ ${route} serves the publisher id`, html.includes(CLIENT), 'not present at all');
    ok(`⚠️ ${route} serves exactly one loader script`, n === 1, `${n} script tags`);
    ok(`${route} loads the script from Google's host`,
      html.includes(`${HOST}${SCRIPT_PATH}?client=${CLIENT}`));
    ok(`${route} serves it async and anonymous`,
      /<script async(?:="")? src="https:\/\/pagead2\.googlesyndication\.com[^"]*"\s+crossorigin="anonymous"/.test(html),
      (html.match(/<script[^>]*googlesyndication[^>]*>/) || [''])[0].slice(0, 120));
    ok(`${route} has it inside <head>`,
      html.indexOf(CLIENT) > 0 && html.indexOf(CLIENT) < html.indexOf('</head>'));
    // The page still works: its own content is there, not just the tag.
    ok(`${route} still renders its own content`, html.includes('CatalystPit') || html.includes('catalystpit'));
  }
  // ⚠️ AND THE SCRIPT ITSELF IS REACHABLE, so verification is not blocked by a bad URL.
  try {
    const r = await fetch(`https://${HOST}${SCRIPT_PATH}?client=${CLIENT}`, { redirect: 'follow' });
    ok('⚠️ the loader URL itself is reachable and is JavaScript', r.ok
      && /javascript|ecmascript/i.test(r.headers.get('content-type') || ''),
      `HTTP ${r.status} ${r.headers.get('content-type')}`);
  } catch (e) { ok('the loader URL itself is reachable', false, e.message); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
