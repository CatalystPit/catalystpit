// THE PALETTE, IN ITS OWN MODULE.
//
// ⚠️ EXTRACTED TO BREAK AN IMPORT CYCLE. cp-shared's TopNav needs AccountMenu, and AccountMenu needs
// the colour tokens — so with C living in cp-shared the two imported each other. Next tolerated it;
// esbuild did not, and the failure mode was vicious: thirteen unrelated components threw
// "Cannot read properties of undefined (reading 'text')" because `C` was still undefined while
// cp-shared was mid-initialisation. Nothing named the cycle.
//
// A leaf module with no imports of its own cannot participate in a cycle, which is the fix.
// cp-shared re-exports C unchanged, so all ~40 existing `import { C } from './cp-shared'` callers
// are untouched.

// ─── PALETTE ────────────────────────────────────────────────────────────────
// Colors are CSS variables (defined in BrandStyles for light + [data-theme="dark"]) so the whole app
// themes from one place — every `C.x` inline style resolves to the active theme. navBg/greenOnDark
// stay constant (brand). Fallbacks match the light theme so SSR/no-JS still renders correctly.
export const C = {
  bg:"var(--cp-bg,#F5F6F3)", white:"var(--cp-white,#FFFFFF)", surface:"var(--cp-surface,#F0F2EE)", surface2:"var(--cp-surface2,#E8EAE5)",
  border:"var(--cp-border,#E0E2DC)", border2:"var(--cp-border2,#C4C8BE)",
  ink:"var(--cp-ink,#0C1410)", text:"var(--cp-text,#1A2018)", muted:"var(--cp-muted,#5A6458)", dim:"var(--cp-dim,#8A9088)", hint:"var(--cp-hint,#C0C4BC)",
  green:"var(--cp-green,#1E5C38)", greenMid:"var(--cp-greenMid,#2A7848)", greenLight:"var(--cp-greenLight,#E8F5EE)", greenBorder:"var(--cp-greenBorder,#A8CEB8)",
  greenOnDark:"#4FB37C", // brand-green sibling, brightened for readability on dark surfaces — constant
  // ⚠️ THE SELECTED STATE OF A PILL OR TAB. Its own token pair, because the bug it replaces came
  // from using `ink` — a FOREGROUND token — as a BACKGROUND. `ink` is near-black in light and
  // near-white in dark, so `background: C.ink` with white text rendered at 1.12:1 in dark mode: a
  // white blob with invisible text. Measured, on the Screener category pills and the Pit Scan tab.
  //
  // A foreground token used as a background inverts with the theme in exactly the wrong direction,
  // and no amount of care at the call site fixes that. These two say what they are for, so the
  // theme can give each mode the right value: light keeps today's near-black chip unchanged, dark
  // gets the brand's mid-green at 5.41:1 against its text and 3.42:1 against the page behind it.
  selBg:"var(--cp-selBg,#0C1410)", selFg:"var(--cp-selFg,#FFFFFF)",
  red:"var(--cp-red,#A83030)", redLight:"var(--cp-redLight,#FAEAEA)", gold:"var(--cp-gold,#7A5818)",
  blue:"var(--cp-blue,#1A3A78)", blueLight:"var(--cp-blueLight,#E8F0FF)",
  navBg:"#1E5C38",

  // ─── OPPOSING-EVIDENCE TREATMENT ──────────────────────────────────────────
  //
  // Two weights, because the product draws a line between them and the visuals have to draw it too.
  //
  //   conflict* — KEY CONFLICT. Meaningful opposing evidence: the minority side is at least 15% of
  //               the directional total. A tinted surface, a visible border and a left accent bar.
  //   contrary* — MINOR CONTRARY EVIDENCE. Outweighed by more than 5:1. Surfaced, never boxed: a
  //               thin rule and muted warm text, so it reads as a footnote rather than a contest.
  //
  // ⚠️ THESE ARE TOKENS, NOT HEXES. The old KEY CONFLICT box was a literal #FFF4F4, which in dark
  // mode rendered a near-white panel on a near-black card — unreadable, and it looked like a system
  // error rather than a reading of the evidence. Anything conflict-coloured belongs here so both
  // themes stay in step.
  conflictBg:"var(--cp-conflictBg,#FBF1F0)", conflictBorder:"var(--cp-conflictBorder,#E3C0BC)",
  conflictAccent:"var(--cp-conflictAccent,#A83030)", conflictText:"var(--cp-conflictText,#3C2523)",
  contraryRule:"var(--cp-contraryRule,#DCC8C4)", contraryText:"var(--cp-contraryText,#7A6660)",
  // Chip fills for the family/state pills. Themed for the same reason.
  negBg:"var(--cp-negBg,#FBEDED)", warnBg:"var(--cp-warnBg,#FFF6E8)", warnFg:"var(--cp-warnFg,#7A5018)",

  // ─── SMALL OUTLINED BADGES ────────────────────────────────────────────────
  //
  // The LAST CLOSE / DELAYED pills and their siblings. These get their OWN tokens rather than
  // reusing dim + border2, because a badge is not body text and the numbers say so:
  //
  //   8.5–9px, bold, uppercase, letter-spaced — the smallest type in the product. WCAG's 4.5:1
  //   floor is for NORMAL text; the "large text" 3:1 relaxation starts at 18.66px bold. These sit
  //   an order of magnitude the wrong side of that, so they need MORE contrast than body copy,
  //   not less. dim gave them 4.08:1 in dark and 2.90:1 in light — both failing, the dark one
  //   visibly so against the panel's near-black green.
  //
  //   The border is a UI boundary, not text, so it answers to WCAG 1.4.11 at 3:1. border2 gave
  //   it 1.59:1 in dark and 1.70:1 in light — present in the DOM, absent to the eye, which is
  //   why the pill read as a floating word rather than a badge.
  //
  // ⚠️ BADGE FOREGROUND OUTRANKS `muted`, DELIBERATELY. badgeFg is 8.28:1 where muted is 6.16:1.
  // That inversion is not a hierarchy mistake — it is what keeps a 8.5px pill and a 11.5px
  // sentence reading as equally comfortable. Equal contrast at unequal sizes is not equal
  // legibility. Do not "restore order" by dimming this back toward muted.
  badgeFg:"var(--cp-badgeFg,#636E61)", badgeBorder:"var(--cp-badgeBorder,#7E8878)",
};
