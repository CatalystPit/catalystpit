// CLERK'S APPEARANCE, IN CATALYST PIT'S COLOURS, PER THEME.
//
// ── ⚠️ WHY THIS CANNOT USE THE `C` TOKENS ───────────────────────────────────
//
// Every other surface in the product styles itself with `C.white`, `C.ink` and friends, which are
// CSS VARIABLE STRINGS — `C.white` is literally `"var(--cp-white,#FFFFFF)"`. That is what makes the
// app theme from one place: the browser resolves the variable at paint time against
// `:root[data-theme="dark"]`, and `--cp-white` really does become `#161F1A` in dark mode.
//
// Clerk cannot use them. Its appearance layer PARSES colours numerically — it derives whole scales
// from `colorPrimary` and `colorNeutral` — and its colour module (@clerk/shared runtime) handles
// hex, rgb and hsl and contains no handling for `var(` at all. A CSS-variable string is not a
// colour it can read, so it is discarded and Clerk falls back to its own defaults. That is exactly
// why the account page used to pass `C.white` as the card background and still rendered a WHITE
// card in dark mode while everything around it themed correctly: the value was never applied.
//
// So the values below are LITERAL HEX, duplicated from the palette on purpose, and the comment on
// each one names the token it mirrors. If the palette moves, these move with it by hand — the
// alternative is passing Clerk something it will silently ignore.
//
// ── ⚠️ VARIABLES FIRST, ELEMENTS ONLY WHERE STRUCTURE DEMANDS IT ────────────
//
// `variables` is Clerk's supported theming surface and it reaches every subview — Profile, Security,
// modals, menus, inputs, the account rows — without us naming a single internal class. Styling
// individual `elements` instead means guessing at Clerk's internal element names, which change
// between versions and leave any view we forgot in the default palette. Elements are used here only
// for the handful of things variables cannot express: the card's border and radius, the sidebar
// surface, and the two button treatments that carry the brand green.

/** Contrast ratios quoted below are computed against the surface each value actually sits on. */
const LIGHT = {
  // Surfaces. --cp-white / --cp-surface / --cp-surface2 at their light values.
  colorBackground: '#FFFFFF',
  colorMuted: '#F0F2EE',
  colorInputBackground: '#FFFFFF',
  // Text. --cp-ink for primary, --cp-muted for secondary, --cp-text inside inputs.
  colorForeground: '#0C1410',
  colorMutedForeground: '#5A6458',
  colorInputForeground: '#1A2018',
  // Lines. --cp-border: the same hairline the rest of the page uses.
  colorBorder: '#E0E2DC',
  // ⚠️ colorNeutral SEEDS CLERK'S NEUTRAL SCALE, so it must be the INK of the theme, not a surface.
  // Clerk builds alpha shades from it for dividers, hovers and disabled text.
  colorNeutral: '#0C1410',
  // Brand. --cp-green, with white at 7.95:1 on it.
  colorPrimary: '#1E5C38',
  colorPrimaryForeground: '#FFFFFF',
  colorDanger: '#A83030',
  colorSuccess: '#1E5C38',
  colorWarning: '#7A5818',
  colorShimmer: 'rgba(12,20,16,0.06)',
  colorModalBackdrop: 'rgba(12,20,16,0.45)',
};

const DARK = {
  // ⚠️ THE NEAR-BLACK GREEN THE REST OF THE PAGE USES FOR A CARD. --cp-white resolves to this in
  // dark mode, which is the value the old code was trying and failing to hand to Clerk.
  colorBackground: '#161F1A',
  colorMuted: '#1B241F',          // --cp-surface  — sidebar and subtle fills
  colorInputBackground: '#232E28', // --cp-surface2 — inputs sit one step above the card
  // Text. Measured on #161F1A: 15.02:1 and 6.52:1; inside an input on #232E28: 12.53:1.
  colorForeground: '#EEF3EF',      // --cp-ink
  colorMutedForeground: '#98A49B', // --cp-muted
  colorInputForeground: '#EEF3EF',
  // ⚠️ --cp-border2, NOT --cp-border. The darker hairline measures 1.31:1 against the card, which
  // is a divider you cannot find; border2 gives 1.69:1 — still subtle, actually visible.
  colorBorder: '#3A453E',
  // ⚠️ AND THE NEUTRAL SEED INVERTS WITH THE THEME. Leaving it near-black here would have Clerk
  // derive its dividers and disabled text from a colour that vanishes on a dark card.
  colorNeutral: '#EEF3EF',
  // Brand, brightened for dark exactly as --cp-green is (5.71:1 on the card).
  colorPrimary: '#46A874',
  // ⚠️ DARK TEXT ON THE GREEN BUTTON, NOT WHITE. White on #46A874 is 2.95:1 and fails; the near-
  // black gives 6.27:1. This is the same trap the palette documents for selBg/selFg — a foreground
  // colour used as a background inverts in the wrong direction unless the pair is chosen together.
  colorPrimaryForeground: '#0E1512',
  colorDanger: '#E06B6B',          // --cp-red dark, 5.21:1
  colorSuccess: '#46A874',
  colorWarning: '#C79A3C',         // --cp-gold dark
  colorShimmer: 'rgba(238,243,239,0.08)',
  colorModalBackdrop: 'rgba(0,0,0,0.65)',
};

/** Surfaces the element overrides need, per theme. */
const SHELL = {
  light: { card: '#FFFFFF', sidebar: '#F0F2EE', border: '#E0E2DC', greenHover: '#2A7848' },
  dark: { card: '#161F1A', sidebar: '#1B241F', border: '#3A453E', greenHover: '#58BE86' },
};

/**
 * Build the appearance object for Clerk's `<UserProfile>`.
 *
 * @param {'light'|'dark'} theme  the live theme, read from `data-theme` on <html>
 */
export function clerkAppearance(theme) {
  const dark = theme === 'dark';
  const v = dark ? DARK : LIGHT;
  const s = dark ? SHELL.dark : SHELL.light;

  return {
    variables: {
      ...v,
      fontFamily: "'DM Sans',sans-serif",
    },
    elements: {
      rootBox: { width: '100%' },
      // ⚠️ BOTH THE BOX AND THE CARD. Clerk wraps the card in `cardBox`; styling only the inner one
      // leaves a light rim around a dark card in some views.
      cardBox: {
        background: s.card,
        border: `1px solid ${s.border}`,
        borderRadius: 8,
        boxShadow: 'none',
      },
      card: {
        background: s.card,
        border: 'none',
        borderRadius: 8,
        boxShadow: 'none',
      },
      // The left-hand nav — Profile / Security. A step off the card so the split is readable.
      navbar: { background: s.sidebar, borderRight: `1px solid ${s.border}` },
      navbarMobileMenuButton: { color: v.colorForeground },
      headerTitle: { fontFamily: "'DM Sans',sans-serif", color: v.colorForeground },
      headerSubtitle: { color: v.colorMutedForeground },
      profileSectionPrimaryButton: {
        background: v.colorPrimary,
        color: v.colorPrimaryForeground,
        '&:hover': { background: s.greenHover },
      },
      formButtonPrimary: {
        background: v.colorPrimary,
        color: v.colorPrimaryForeground,
        '&:hover': { background: s.greenHover },
        textTransform: 'none',
        fontFamily: "'DM Sans',sans-serif",
        fontWeight: 500,
      },
    },
  };
}

export const CLERK_THEME_VALUES = { light: LIGHT, dark: DARK, shell: SHELL };
