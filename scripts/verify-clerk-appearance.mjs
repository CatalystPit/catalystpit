// THE CLERK PROFILE'S COLOURS — pinned against Clerk's own type definition and against contrast.
//
// ── ⚠️ WHAT THIS EXISTS TO PREVENT ──────────────────────────────────────────
//
// The bug this suite was written for was SILENT. The account page handed Clerk
// `background: C.white`, which is the string `"var(--cp-white,#FFFFFF)"`, and Clerk — which parses
// colours numerically to derive its scales and has no handling for `var(` anywhere in its colour
// module — discarded it and used its own default. Light mode looked right by coincidence, dark mode
// rendered a white card on a near-black page, and nothing anywhere reported a problem.
//
// Two failure modes follow from that, and both are asserted below:
//
//   1. A VALUE CLERK CANNOT PARSE. Anything containing `var(` is ignored, so it must never appear.
//   2. A KEY CLERK DOES NOT HAVE. A typo like `colorSecondary` is not an error — it is ignored in
//      exactly the same silent way. So every key we send is checked against the Variables type in
//      the INSTALLED @clerk/shared, which means a Clerk upgrade that renames a variable fails here
//      rather than in production.
//
// Run: node scripts/verify-clerk-appearance.mjs

import fs from 'node:fs';
import { clerkAppearance, CLERK_THEME_VALUES } from '../src/lib/clerk-appearance.mjs';

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

// ── contrast, the same formula the palette notes quote ──────────────────────
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// ── 1. EVERY KEY EXISTS IN THE INSTALLED CLERK ──────────────────────────────
sec('⚠️ EVERY VARIABLE WE SEND IS ONE CLERK ACTUALLY HAS');
{
  // Parsed from the installed package rather than hard-coded, so a Clerk upgrade that renames or
  // drops a variable turns this red instead of silently dropping our colour.
  const candidates = [
    'node_modules/@clerk/shared/dist/runtime/index-BgfSt8Sh.d.ts',
    'node_modules/@clerk/shared/dist/runtime/index-dd7stztF.d.mts',
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  check('⚠️ Clerk\'s Variables type is readable from node_modules', !!file,
    'none of: ' + candidates.join(', '));

  if (file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let i = lines.findIndex((l) => /colorPrimary\?: CssColorOrScale;/.test(l));
    for (let j = i; j > Math.max(0, i - 200); j--) {
      if (/^(export )?(type|interface) [A-Za-z]*Variables/.test(lines[j].trim())) { i = j; break; }
    }
    let depth = 0, started = false;
    const known = new Set();
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
      const m = lines[j].match(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/);
      if (started && m && depth >= 1) known.add(m[1]);
      if (started && depth === 0) break;
    }
    check('…and it lists the colour variables we rely on',
      known.has('colorBackground') && known.has('colorForeground') && known.has('colorNeutral'),
      `${known.size} keys parsed`);

    // fontFamily is a typography variable and may sit outside the colour block; allowed explicitly.
    const ALLOWED_EXTRA = new Set(['fontFamily']);
    for (const theme of ['light', 'dark']) {
      const sent = Object.keys(clerkAppearance(theme).variables);
      const unknown = sent.filter((k) => !known.has(k) && !ALLOWED_EXTRA.has(k));
      check(`⚠️ ${theme}: no variable name Clerk would silently ignore`,
        unknown.length === 0, unknown.join(', '));
    }
  }
}

// ── 2. NOTHING CLERK CANNOT PARSE ───────────────────────────────────────────
sec('⚠️ NO CSS VARIABLE STRINGS — THE ORIGINAL BUG');
{
  for (const theme of ['light', 'dark']) {
    const a = clerkAppearance(theme);
    const flat = JSON.stringify(a);
    check(`⚠️ ${theme}: the appearance contains no var(...) anywhere`,
      !flat.includes('var('), (flat.match(/var\([^)]*\)/) || [''])[0]);
    // every colour variable must be a literal Clerk can read: hex, rgb/rgba or hsl/hsla
    const bad = Object.entries(a.variables)
      .filter(([k]) => k.startsWith('color'))
      .filter(([, v]) => !/^#[0-9a-f]{3,8}$/i.test(v) && !/^rgba?\(/i.test(v) && !/^hsla?\(/i.test(v));
    check(`…and every colour is a literal hex/rgb/hsl value`, bad.length === 0,
      bad.map(([k, v]) => `${k}=${v}`).join(', '));
  }
}

// ── 3. LIGHT MODE IS UNCHANGED ──────────────────────────────────────────────
sec('⚠️ LIGHT MODE PRESERVES WHAT ALREADY WORKED');
{
  const l = clerkAppearance('light');
  // The four values the old code passed, now as the literals Clerk can actually read.
  check('the card is still white', l.elements.card.background === '#FFFFFF');
  check('the sidebar is still the surface tone', l.elements.navbar.background === '#F0F2EE');
  check('the hairline is still --cp-border', l.variables.colorBorder === '#E0E2DC');
  check('headings are still --cp-ink', l.elements.headerTitle.color === '#0C1410');
  check('⚠️ the brand green is unchanged', l.variables.colorPrimary === '#1E5C38');
  check('…with white on it, as before', l.variables.colorPrimaryForeground === '#FFFFFF');
  check('the primary button still carries the brand green',
    l.elements.formButtonPrimary.background === '#1E5C38'
    && l.elements.formButtonPrimary.color === '#FFFFFF');
  check('the font is still DM Sans', /DM Sans/.test(l.variables.fontFamily));
}

// ── 4. DARK MODE IS READABLE ────────────────────────────────────────────────
sec('⚠️ DARK MODE MEETS CONTRAST ON EVERY SURFACE IT PAINTS');
{
  const d = clerkAppearance('dark');
  const v = d.variables;
  const card = v.colorBackground, side = v.colorMuted, input = v.colorInputBackground;

  check('⚠️ the card is the near-black green, not white', card === '#161F1A', card);
  check('…and it is genuinely dark', lum(card) < 0.05, `luminance ${lum(card).toFixed(4)}`);
  check('the sidebar is a distinct dark surface', side === '#1B241F' && side !== card);

  const r1 = ratio(v.colorForeground, card);
  check('⚠️ primary text is clearly readable on the card', r1 >= 4.5, `${r1.toFixed(2)}:1`);
  const r2 = ratio(v.colorMutedForeground, card);
  check('⚠️ secondary text has sufficient contrast', r2 >= 4.5, `${r2.toFixed(2)}:1`);
  const r3 = ratio(v.colorMutedForeground, side);
  check('…including on the sidebar', r3 >= 4.5, `${r3.toFixed(2)}:1`);
  const r4 = ratio(v.colorInputForeground, input);
  check('⚠️ input text is readable on the input surface', r4 >= 4.5, `${r4.toFixed(2)}:1`);

  // ⚠️ A DIVIDER HAS TO BE FINDABLE. --cp-border is 1.31:1 against this card, which is not; the
  // suite pins the brighter --cp-border2 so a future "tidy-up" cannot quietly re-darken it.
  const rb = ratio(v.colorBorder, card);
  check('⚠️ borders are visible but subtle', rb >= 1.5 && rb <= 3.5, `${rb.toFixed(2)}:1`);

  // ⚠️ THE BUTTON PAIR. White on the dark-mode green is 2.95:1 and fails; the pair has to be
  // chosen together, which is the same trap the palette documents for selBg/selFg.
  const rp = ratio(v.colorPrimaryForeground, v.colorPrimary);
  check('⚠️ primary-button text is readable ON the green, not merely brand-correct',
    rp >= 4.5, `${rp.toFixed(2)}:1`);
  check('…and it is NOT white, which would fail here',
    v.colorPrimaryForeground.toUpperCase() !== '#FFFFFF');
  check('the green is the dark-mode brand green', v.colorPrimary === '#46A874');
  const rg = ratio(v.colorPrimary, card);
  check('…and the accent itself reads against the card', rg >= 3, `${rg.toFixed(2)}:1`);
  const rd = ratio(v.colorDanger, card);
  check('destructive actions are readable', rd >= 4.5, `${rd.toFixed(2)}:1`);

  // ⚠️ THE NEUTRAL SEED INVERTS WITH THE THEME. Clerk derives dividers, hovers and disabled text
  // from it; a near-black seed on a near-black card produces invisible furniture.
  check('⚠️ the neutral scale seed is light on dark, not the light-mode ink',
    lum(v.colorNeutral) > 0.5 && v.colorNeutral !== CLERK_THEME_VALUES.light.colorNeutral,
    v.colorNeutral);
}

// ── 5. IT ACTUALLY SWITCHES ─────────────────────────────────────────────────
sec('⚠️ THE TWO THEMES ARE DIFFERENT OBJECTS');
{
  const l = clerkAppearance('light'), d = clerkAppearance('dark');
  check('backgrounds differ', l.variables.colorBackground !== d.variables.colorBackground);
  check('foregrounds differ', l.variables.colorForeground !== d.variables.colorForeground);
  check('card surfaces differ', l.elements.card.background !== d.elements.card.background);
  check('sidebars differ', l.elements.navbar.background !== d.elements.navbar.background);
  // anything not 'dark' is light — the hook only ever yields 'light' | 'dark', and an unexpected
  // value must not produce a third, half-styled theme.
  check('⚠️ an unknown theme falls back to light, never to a partial theme',
    JSON.stringify(clerkAppearance('sepia')) === JSON.stringify(l)
    && JSON.stringify(clerkAppearance(undefined)) === JSON.stringify(l));
}

// ── 6. THE PAGE WIRES IT UP ─────────────────────────────────────────────────
sec('⚠️ THE ACCOUNT PAGE FEEDS IT THE LIVE THEME');
{
  const page = fs.readFileSync('src/app/account/page.jsx', 'utf8');
  check('the page reads the live theme', /useTheme\(\)/.test(page));
  check('…and hands it to Clerk', /clerkAppearance\(theme\)/.test(page));
  check('⚠️ …and remounts on a theme flip so open subviews repaint', /key=\{theme\}/.test(page));
  check('⚠️ no CSS-variable token is passed to Clerk any more',
    !/appearance=\{\{[\s\S]*C\.(white|ink|border|surface|green)/.test(page));

  const shared = fs.readFileSync('src/lib/cp-shared.jsx', 'utf8');
  // ⚠️ THE FIRST RENDER HAS TO BE RIGHT. Clerk's colours are a PROP; unlike every `C.x` style the
  // browser cannot correct them at paint time, so a hook that starts at "light" paints a white card
  // and then flips.
  check('⚠️ useTheme resolves the theme on its FIRST render, not one frame later',
    /useState\(\(\) =>[\s\S]{0,200}dataset\.theme === "dark"/.test(shared));
  check('…and is guarded for the server, where there is no document',
    /typeof document !== "undefined"/.test(shared));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
