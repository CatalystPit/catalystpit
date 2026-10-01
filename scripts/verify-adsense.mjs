// GOOGLE ADSENSE SITE VERIFICATION — OWNERSHIP IN THE DOCUMENT, THE LOADER BEHIND THE ENTITLEMENT GATE.
//
//   node scripts/verify-adsense.mjs                                  (the source and the built HTML)
//   CP_ADSENSE_LIVE=https://catalystpit.com node scripts/verify-adsense.mjs   (+ the deployed site)
//
// ⚠️ THIS SUITE ASSERTED THE OPPOSITE OF THE CURRENT RULE, AND THAT IS WHY IT IS REWRITTEN RATHER THAN
// REPAIRED. It was written when the only requirement was Google's crawler finding the loader, so it
// required `<script async src={ADSENSE_SRC}>` in the root layout's <head> and the publisher id in all 24
// prerendered pages. Pro ad-free enforcement made that exact shape the defect: a loader in the layout
// loads for EVERY visitor, which is an ad request made on behalf of someone who paid not to see one —
// and hiding the result afterwards is not the same thing as never asking. Fourteen assertions here were
// demanding that behaviour back.
//
// WHAT IS TRUE NOW, and what this file asserts instead:
//
//   ownership   <meta name="google-adsense-account"> in the root layout. Google accepts this for site
//               verification and it is inert: no script, no request, no slot.
//   the loader  created from the client by <AdSenseLoader/> → runAdsGate(), and ONLY for a visitor whose
//               tier is eligible. Signed out loads it; Free loads it; Pro and Elite never do; an
//               unresolved plan denies. Those branches are EXECUTED in verify-pro-adfree.mjs.
//   the document never carries a loader at all, on any route, prerendered or live — which is now the
//               assertion, inverted from what it used to be.
//
// Section 3 survives unchanged in intent: a verification tag and a gated loader are both still a long
// way from a declared ad placement, and nothing here may push to the queue or reserve a slot.

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
 * ⚠️ NOT A COUNT OF THE PUBLISHER ID, AND THE DIFFERENCE MATTERS. The id appears in the RSC flight
 * payload — the serialized React tree Next embeds so the client can hydrate — as a DESCRIPTION of an
 * element rather than a second element, and it causes no request. Counting occurrences of the id once
 * reported "23 pages with a duplicate" for a document carrying exactly one loader. It matters in the
 * other direction now too: the meta tag carries the id, so the id being present says nothing about
 * whether a script is.
 */
const scriptTagCount = (html) => (html.match(/<script[^>]*pagead2\.googlesyndication\.com[^>]*>/g) || []).length;
const HOST = 'pagead2.googlesyndication.com';
const SCRIPT_PATH = '/pagead/js/adsbygoogle.js';

// ── 1. ownership is declared in the document; the loader is NOT ─────────────────────────────────
console.log('\n1. ownership is declared in the document; the loader is not');

const layout = read('src/app/layout.jsx');
const ads = read('src/lib/adsense.mjs');

ok('the publisher id is declared once, in lib/adsense.mjs',
  ads.includes(`export const ADSENSE_CLIENT = '${CLIENT}'`)
  && (ads.match(new RegExp(CLIENT, 'g')) || []).length === 1);
ok('…and the layout imports it rather than restating it',
  /import \{ ADSENSE_CLIENT \} from '\.\.\/lib\/adsense\.mjs';/.test(layout)
  && !layout.includes(`'${CLIENT}'`));
ok('⚠️ ownership is asserted with the meta tag, which makes no request',
  /<meta name="google-adsense-account" content=\{ADSENSE_CLIENT\} \/>/.test(layout));
// ⚠️ THE INVERSION. A loader in the layout is a request made for every visitor, Pro included.
ok('⚠️ the layout renders NO loader script',
  !/<script[^>]*ADSENSE_SRC/.test(layout) && !layout.includes(HOST),
  (layout.match(new RegExp(`[^\n]*${HOST}[^\n]*`)) || [''])[0].slice(0, 100));
ok('⚠️ …and the loader URL is built in one place only',
  ads.includes(`https://${HOST}${SCRIPT_PATH}?client=`));

// ── 2. the loader is created from the client, behind the gate ───────────────────────────────────
console.log('\n2. the loader is created from the client, behind the gate');

const loader = read('src/components/AdSenseLoader.jsx');
ok('the gate component is mounted in the layout', /<AdSenseLoader \/>/.test(layout));
ok('⚠️ …at the end of <body>, not in <head>',
  layout.indexOf('<AdSenseLoader />') > layout.indexOf('</head>'));
ok('it is a client component, because an entitlement it cannot read is useless',
  /^'use client'/.test(loader));
ok('⚠️ the decision is delegated to the gate, not written in the effect',
  /runAdsGate\(/.test(loader) && !/document\.createElement/.test(loader));
ok('⚠️ an identity change re-runs it, so a sign-in cannot leave ads from the previous visitor',
  /\}, \[isLoaded, isSignedIn, userId\]\);/.test(loader));
ok('…and it renders nothing', /return null;/.test(loader));

// ⚠️ THE RULE IS AN ALLOW-LIST, AND THE DIFFERENCE IS NOT STYLISTIC. `tier !== 'pro'` grants ads to every
// tier that is not literally that string — including a future tier, a typo, and undefined.
// ⚠️ AGAINST THE CODE, NOT THE COMMENT ABOVE IT. adsense.mjs explains the rule by naming the rejected
// form — "Written as `tier !== 'pro'` a new paid tier would default to being shown ads" — so a bare
// !/tier !== 'pro'/ over the whole file fails on correct code, accusing the implementation of the very
// thing the comment exists to prevent. Line comments are stripped before block comments, because this
// codebase contains `/*` inside line comments and the other order opens a phantom block.
const adsCode = ads.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
ok('⚠️ eligibility is an explicit allow-list, not a negation of Pro',
  /tier === 'free'/.test(adsCode) && !/tier !== 'pro'/.test(adsCode));
ok('⚠️ an unresolved or failed plan lookup DENIES', /\.catch\(\(\) => 'deny'\)/.test(ads));
ok('⚠️ …and so does a still-hydrating identity',
  /if \(!isLoaded\) return \{ decision: Promise\.resolve\('wait'\)/.test(ads));
ok('⚠️ the loader cannot be created twice', /if \(doc\.querySelector\(`script\[\$\{ADS_MARK\}\]`\)\) return false;/.test(ads));
// Every one of those branches is EXECUTED, not matched, in its own suite.
ok('the branches are exercised against a stub document elsewhere',
  fs.existsSync(path.join(ROOT, 'scripts/verify-pro-adfree.mjs')));

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
// ⚠️ ONE FILE NAMES GOOGLE'S AD HOST, AND IT IS NO LONGER THE LAYOUT. The URL moved into lib/adsense.mjs
// beside the gate that decides whether to use it, so the decision and the thing it decides about cannot
// drift apart. Still exactly one file: a second would be a second way to load advertising.
const refs = all.filter((f) => read(f).includes(HOST));
ok('⚠️ exactly one file references Google\'s ad host',
  refs.length === 1 && refs[0] === 'src/lib/adsense.mjs', refs.join(', '));

// ── 4. nothing else in the head moved ──────────────────────────────────────────────────────────
console.log('\n4. nothing else in the head moved');

// ⚠️ PRESENT *AND* FIRST. `indexOf` returns -1 for something absent, and -1 is less than any index — so
// the ordering test alone passed when the theme script had been deleted outright, which is a worse
// outcome than the wrong order. Existence is asserted before position.
const themeAt = layout.indexOf("localStorage.getItem('cp_theme')");
ok('the pre-paint theme script is still there', themeAt > 0);
// ⚠️ THE ORDERING QUESTION DISSOLVED WITH THE LOADER. There is no ad tag in the document to run before
// or after, so "the theme cannot flash because it runs first" is no longer the guarantee — the guarantee
// is that the theme script is in <head> and still pre-paint, which is what is asserted instead.
ok('…and still runs pre-paint, inside <head>',
  themeAt > layout.indexOf('<head>') && themeAt < layout.indexOf('</head>'),
  `theme@${themeAt} head@${layout.indexOf('<head>')}..${layout.indexOf('</head>')}`);
ok('both ld+json blocks are still emitted server-side',
  (layout.match(/type="application\/ld\+json"/g) || []).length === 2);
ok('the font preconnects and stylesheet are intact',
  layout.includes('rel="preconnect" href="https://fonts.googleapis.com"')
  && layout.includes('fonts.googleapis.com/css2?family=Cormorant'));
ok('Clerk still wraps the tree', /<ClerkProvider>/.test(layout));
ok('suppressHydrationWarning is still on <html>', /<html lang="en" suppressHydrationWarning>/.test(layout));

// ── 5. the BUILT html, not just the source ─────────────────────────────────────────────────────
console.log('\n5. the built html, not just the source');

// ⚠️ THE CLAIM IS NOW THE ABSENCE, AND IT STILL HAS TO BE CHECKED IN THE DOCUMENT. A gate written in a
// client component proves nothing about what Next renders: if the loader were ever moved back into the
// server tree it would appear here, in every prerendered page, before any gate could run. So the
// prerendered output is swept for a loader script and must contain none — while the ownership meta tag
// must be present in all of them, since that is what Google reads.
const builtDir = path.join(ROOT, '.next/server/app');
if (fs.existsSync(builtDir)) {
  const htmls = fs.readdirSync(builtDir).filter((f) => f.endsWith('.html'));
  ok('the build produced prerendered html to inspect', htmls.length > 0, `${htmls.length} files`);
  let withLoader = 0, withMeta = 0;
  const offending = [];
  for (const f of htmls) {
    const html = fs.readFileSync(path.join(builtDir, f), 'utf8');
    if (scriptTagCount(html) > 0) { withLoader += 1; offending.push(f); }
    if (/<meta name="google-adsense-account" content="ca-pub-/.test(html)) withMeta += 1;
  }
  ok('⚠️ NO prerendered page carries a loader script', withLoader === 0,
    `${withLoader} page(s): ${offending.slice(0, 4).join(', ')}`);
  ok('⚠️ …while every one of them carries the ownership meta tag', withMeta === htmls.length,
    `${withMeta}/${htmls.length}`);
  const sample = fs.readFileSync(path.join(builtDir, htmls[0]), 'utf8');
  ok('the meta tag is inside the document head',
    sample.indexOf('google-adsense-account') > 0
    && sample.indexOf('google-adsense-account') < sample.indexOf('</head>'));
  // ⚠️ THE PUBLISHER ID MAY APPEAR; A REQUEST TO GOOGLE MAY NOT. The id is in the meta tag by design, so
  // the thing to forbid is the host, not the identifier.
  ok('⚠️ and nothing in the prerendered document points at Google\'s ad host',
    !sample.includes(HOST),
    (sample.match(new RegExp(`.{0,60}${HOST.replace(/\./g, '\\.')}.{0,40}`)) || [''])[0]);
} else {
  console.log('  (no .next build found — run `next build` first to check the rendered html)');
}

// ── 6. the DEPLOYED site, which is the only claim Google checks ─────────────────────────────────
const LIVE = process.env.CP_ADSENSE_LIVE || null;
console.log(`\n6. the deployed site ${LIVE ? `(${LIVE})` : '(skipped — set CP_ADSENSE_LIVE)'}`);

if (LIVE) {
  // Several routes, not one: the meta tag is in the root layout, so every page must carry it — and no
  // page may carry a loader, because the served document is what a Pro subscriber's browser receives
  // before any client gate has had a chance to decide anything.
  for (const route of ['/', '/fear-greed', '/ticker/AAPL', '/terminal', '/privacy']) {
    let html = null;
    try {
      const r = await fetch(`${LIVE}${route}`, { cache: 'no-store', redirect: 'follow' });
      html = r.ok ? await r.text() : null;
      ok(`${route} responds`, r.ok, `HTTP ${r.status}`);
    } catch (e) { ok(`${route} responds`, false, e.message); }
    if (!html) continue;
    const n = scriptTagCount(html);
    ok(`⚠️ ${route} asserts ownership`,
      /<meta name="google-adsense-account" content="ca-pub-/.test(html), 'meta tag not present');
    ok(`⚠️ ${route} serves NO loader script`, n === 0, `${n} script tags`);
    ok(`⚠️ ${route} does not reach Google's ad host at all`, !html.includes(HOST));
    ok(`${route} has the meta tag inside <head>`,
      html.indexOf('google-adsense-account') > 0
      && html.indexOf('google-adsense-account') < html.indexOf('</head>'));
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
