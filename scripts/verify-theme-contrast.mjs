// THEME TOKENS AND CONTRAST.
//
// The defect this exists to prevent: the KEY CONFLICT box was a literal `#FFF4F4`. In light mode
// that is a faint pink panel; in dark mode it is a near-WHITE panel on a near-black card, which is
// both unreadable and reads as a system error rather than as "these sources disagree".
//
// So this suite checks two things that a screenshot review would catch late and a unit test never
// catches at all:
//
//   1. every token defined for light mode also exists for dark mode, and vice versa
//   2. the resulting text/background pairs actually meet WCAG AA in BOTH themes
//
// It parses the real CSS variable blocks out of BrandStyles rather than re-declaring the palette
// here, because a copy of the palette would be the thing that drifts.
//
// Run: node scripts/verify-theme-contrast.mjs [--mutate=<mode>]

import fs from 'node:fs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// ── WCAG 2.1 relative luminance and contrast ratio ──────────────────────────
const srgb = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * srgb((n >> 16) & 255) + 0.7152 * srgb((n >> 8) & 255) + 0.0722 * srgb(n & 255);
};
const ratio = (a, b) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// Self-check: the maths must be right before anything it proves means anything.
L('=== THE CONTRAST FUNCTION ITSELF ===');
{
  ok('black on white is 21:1', Math.abs(ratio('#000000', '#FFFFFF') - 21) < 0.01);
  ok('a colour against itself is 1:1', Math.abs(ratio('#3A2024', '#3A2024') - 1) < 0.001);
  ok('the ratio is symmetric', ratio('#A83030', '#FFFFFF') === ratio('#FFFFFF', '#A83030'));
  // A known reference point: #767676 on white is the canonical WCAG AA boundary for body text.
  ok('#767676 on white sits on the AA boundary', Math.abs(ratio('#767676', '#FFFFFF') - 4.54) < 0.05);
}

// ── PARSE THE REAL TOKENS ───────────────────────────────────────────────────
const src = fs.readFileSync(new URL('../src/lib/cp-shared.jsx', import.meta.url), 'utf8');
const block = (selector) => {
  const i = src.indexOf(selector);
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  const close = src.indexOf('}', open);
  const out = {};
  for (const m of src.slice(open, close).matchAll(/--cp-([A-Za-z0-9]+)\s*:\s*(#[0-9A-Fa-f]{6})/g)) {
    out[m[1]] = m[2].toUpperCase();
  }
  return out;
};
const light = block(':root{');
const dark = block(':root[data-theme="dark"]');

L('\n=== BOTH THEMES DEFINE THE SAME TOKENS ===');
{
  ok('the light palette was found', !!light && Object.keys(light).length > 20, String(Object.keys(light || {}).length));
  ok('the dark palette was found', !!dark && Object.keys(dark).length > 20, String(Object.keys(dark || {}).length));
  const onlyLight = Object.keys(light).filter((k) => !(k in dark));
  const onlyDark = Object.keys(dark).filter((k) => !(k in light));
  // A token defined for one theme only is the exact shape of this bug: it falls back to the light
  // value in dark mode, which is how a near-white panel ends up on a near-black card.
  ok('no token exists in light mode only',
    mut('orphan') ? false : onlyLight.length === 0, onlyLight.join(', '));
  ok('no token exists in dark mode only', onlyDark.length === 0, onlyDark.join(', '));
}

// ── THE PAIRS THAT ARE ACTUALLY RENDERED ────────────────────────────────────
//
// Each entry is [description, foreground token, background token, minimum ratio]. 4.5 is WCAG AA
// for body text; 3.0 is AA for large/bold text and for non-text UI boundaries.
const PAIRS = [
  ['conflict body text on the conflict surface', 'conflictText', 'conflictBg', 4.5],
  ['KEY CONFLICT label on the conflict surface', 'conflictAccent', 'conflictBg', 4.5],
  ['the conflict accent bar against the card', 'conflictAccent', 'white', 3.0],
  ['minor contrary text on the card', 'contraryText', 'white', 4.5],
  ['minor contrary text on the page background', 'contraryText', 'bg', 4.5],
  ['negative chip text on its fill', 'red', 'negBg', 4.5],
  ['warning chip text on its fill', 'warnFg', 'warnBg', 4.5],
  ['positive chip text on its fill', 'green', 'greenLight', 4.5],
  ['body text on the card', 'text', 'white', 4.5],
  ['muted text on the card', 'muted', 'white', 4.5],
];

for (const [themeName, theme] of [['LIGHT', light], ['DARK', dark]]) {
  L(`\n=== ${themeName} MODE CONTRAST ===`);
  for (const [label, fg, bg, min] of PAIRS) {
    const a = theme[fg], b = theme[bg];
    if (!a || !b) { ok(`${label} — tokens exist`, false, `missing ${!a ? fg : bg}`); continue; }
    const r = ratio(a, b);
    ok(`${label} ≥ ${min}:1`,
      mut('contrast') ? false : r >= min,
      `${a} on ${b} = ${r.toFixed(2)}`);
  }
}

L('\n=== DARK MODE IS ACTUALLY DARK ===');
{
  // The literal defect. A conflict surface must never be a light panel in dark mode — and the test
  // is written against the CARD, not against a fixed lightness number, so it keeps meaning if the
  // palette is ever rebalanced.
  const cardL = lum(dark.white);
  for (const t of ['conflictBg', 'negBg', 'warnBg', 'greenLight', 'redLight']) {
    ok(`dark ${t} is no lighter than a small step above the card`,
      mut('white') ? false : lum(dark[t]) < cardL + 0.05,
      `${dark[t]} luminance ${lum(dark[t]).toFixed(3)} vs card ${cardL.toFixed(3)}`);
  }
  ok('the dark conflict surface is not a near-white value',
    lum(dark.conflictBg) < 0.2, dark.conflictBg);
  // And it must be distinguishable from the card at all — a conflict surface identical to the card
  // would pass every contrast check above while showing the reader nothing.
  ok('the dark conflict surface differs from the card', dark.conflictBg !== dark.white);
  ok('the dark conflict surface is warmer than the card', (() => {
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [cr, , cb] = hex(dark.white); const [fr, , fb] = hex(dark.conflictBg);
    return (fr - fb) > (cr - cb);            // more red-over-blue than the neutral card
  })(), `${dark.conflictBg} vs ${dark.white}`);
}

L('\n=== THE CONFLICT TREATMENT IS NOT AN ALARM ===');
{
  // "Meaningful opposing evidence", not "system error". A saturated or vivid fill would say the
  // wrong thing however well it scored on contrast.
  const sat = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  };
  for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
    ok(`the ${themeName} conflict surface is a tint, not a saturated fill`,
      sat(theme.conflictBg) < 0.45, `${theme.conflictBg} saturation ${sat(theme.conflictBg).toFixed(2)}`);
  }
  ok('the dark accent is not neon', sat(dark.conflictAccent) < 0.55, dark.conflictAccent);
}

L('\n=== KEY CONFLICT AND MINOR CONTRARY ARE VISUALLY DISTINCT ===');
{
  // The product draws a hard line between meaningful opposition and evidence outweighed by more
  // than 5:1. If both rendered the same, the distinction would exist only in the engine.
  for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
    ok(`${themeName}: the contrary rule is not the conflict border`,
      theme.contraryRule !== theme.conflictBorder);
    ok(`${themeName}: contrary text is quieter than the conflict accent`,
      mut('sameweight') ? false
        : ratio(theme.contraryText, theme.white) < ratio(theme.conflictAccent, theme.white),
      `${ratio(theme.contraryText, theme.white).toFixed(2)} vs ${ratio(theme.conflictAccent, theme.white).toFixed(2)}`);
  }
  // MINOR CONTRARY must never get a filled surface: no token pairs it with a background.
  const row = fs.readFileSync(new URL('../src/app/consensus/ConsensusRow.jsx', import.meta.url), 'utf8');
  const panel = fs.readFileSync(new URL('../src/components/ConsensusPanel.jsx', import.meta.url), 'utf8');
  const minorBlock = (s) => {
    const i = s.indexOf('minorContrary');
    return i < 0 ? '' : s.slice(i, i + 700);
  };
  for (const [name, s] of [['board row', row], ['ticker panel', panel]]) {
    ok(`${name}: minor contrary evidence gets no filled box`,
      !/background:\s*C\.(conflictBg|negBg|redLight)/.test(minorBlock(s)));
    ok(`${name}: …but it IS still shown`, /Minor contrary evidence/.test(s));
  }
}

L('\n=== NO CONFLICT COLOUR IS HARDCODED ON THE CONSENSUS SURFACES ===');
{
  // Tokens only. A literal hex cannot respond to the theme, which is how this defect shipped.
  const files = ['../src/app/consensus/ConsensusRow.jsx', '../src/components/ConsensusPanel.jsx',
    '../src/components/ConsensusTeaser.jsx'];
  for (const f of files) {
    const s = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    // Hexes inside comments are describing the bug, not causing it.
    const code = s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const hexes = [...code.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((m) => m[0]);
    ok(`${f.split('/').pop()} uses theme tokens, not literal colours`,
      mut('hardcode') ? false : hexes.length === 0, hexes.join(', '));
  }
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
