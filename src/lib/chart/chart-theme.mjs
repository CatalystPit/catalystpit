// Catalyst Pit chart palettes, in CONCRETE colours.
//
// WHY THIS EXISTS RATHER THAN REUSING C FROM cp-shared. Those values are CSS custom properties —
// "var(--cp-muted,#5A6458)" — which is exactly right for the DOM and useless to Lightweight Charts.
// The chart paints onto a <canvas>, and a canvas colour is parsed by the 2D context, which does not
// resolve var(). An invalid colour there is silently ignored and the previous value is kept, so the
// chart does not error: it just renders in the wrong colour and nobody notices until the theme is
// switched. The existing TickerChart passes C.muted straight into layout.textColor and has this bug.
//
// So the chart gets real hex, resolved once per theme, and the two palettes below are the single
// place chart colour is decided.

/** Brand green and red, shared by both themes: they are the product's up/down, not a theme choice. */
const UP = '#1E5C38';
const UP_DARK = '#4FB37C';      // the brand-green sibling cp-shared already uses on dark surfaces
const DOWN = '#C0392B';
const DOWN_DARK = '#E5675A';

export const CHART_THEMES = {
  light: {
    background: '#FFFFFF',
    text: '#5A6458',
    textStrong: '#0C1410',
    grid: 'rgba(0,0,0,0.05)',
    border: '#E0E2DC',
    crosshair: 'rgba(0,0,0,0.28)',
    up: UP,
    down: DOWN,
    // Volume sits behind price and must never compete with it.
    volumeUp: 'rgba(30,92,56,0.32)',
    volumeDown: 'rgba(192,57,43,0.30)',
    areaLine: UP,
    areaTop: 'rgba(30,92,56,0.20)',
    areaBottom: 'rgba(30,92,56,0)',
    tooltipBg: '#FFFFFF',
    tooltipBorder: '#E0E2DC',
    // Menu row states. `grid` is deliberately near-invisible (it is a chart gridline) and cannot
    // carry "this row is selected", so the menus get their own two values.
    menuHover: 'rgba(0,0,0,0.055)',
    menuActive: 'rgba(30,92,56,0.10)',
  },
  dark: {
    background: '#0E1512',
    text: '#8A9088',
    textStrong: '#E8EAE5',
    grid: 'rgba(255,255,255,0.06)',
    border: '#243029',
    crosshair: 'rgba(255,255,255,0.32)',
    up: UP_DARK,
    down: DOWN_DARK,
    volumeUp: 'rgba(79,179,124,0.30)',
    volumeDown: 'rgba(229,103,90,0.28)',
    areaLine: UP_DARK,
    areaTop: 'rgba(79,179,124,0.22)',
    areaBottom: 'rgba(79,179,124,0)',
    tooltipBg: '#141C18',
    tooltipBorder: '#243029',
    menuHover: 'rgba(255,255,255,0.07)',
    menuActive: 'rgba(79,179,124,0.14)',
  },
};

export const palette = (theme) => CHART_THEMES[theme === 'dark' ? 'dark' : 'light'];

/**
 * Indicator line colours, indexed rather than named.
 *
 * An indicator declares a colour INDEX, not a hex value, because the chart has two themes and a
 * colour picked to read on white is unreadable on the dark surface. The registry stays theme-free
 * and the theme owns the palette, which is the same split as everything else in this folder.
 *
 * Chosen to stay distinguishable from the up/down candle colours, so a moving average is never
 * mistaken for price action.
 */
const INDICATOR_COLORS = {
  light: ['#1A3A78', '#7A5818', '#7B3F98', '#2A7848', '#B4530A', '#0F6E6E'],
  dark:  ['#6FA8FF', '#E0B84A', '#C08CE0', '#4FB37C', '#F0913F', '#4FC5C5'],
};

export const indicatorColors = (theme) => INDICATOR_COLORS[theme === 'dark' ? 'dark' : 'light'];
export const indicatorColor = (theme, index) => {
  const arr = indicatorColors(theme);
  return arr[((Number(index) || 0) % arr.length + arr.length) % arr.length];
};

/**
 * Chart options for a theme, in the shape Lightweight Charts v5 expects.
 *
 * Kept as a pure function of (theme, options) so a theme switch is `chart.applyOptions(chartOptions(next))`
 * rather than tearing the chart down and rebuilding it — which would lose the user's zoom and pan.
 */
export function chartOptions(theme, { intraday = false, transparent = false } = {}) {
  const p = palette(theme);
  return {
    layout: {
      background: { color: transparent ? 'transparent' : p.background },
      textColor: p.text,
      fontFamily: "'DM Sans', sans-serif",
      fontSize: 11,
      attributionLogo: false,      // the visible credit is rendered by us; see CHART_ATTRIBUTION
    },
    grid: { vertLines: { visible: false }, horzLines: { color: p.grid } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.26 } },
    timeScale: {
      borderVisible: false,
      timeVisible: intraday,
      secondsVisible: false,
      rightOffset: 2,
    },
    crosshair: {
      vertLine: { color: p.crosshair, width: 1, style: 3, labelBackgroundColor: p.up },
      horzLine: { color: p.crosshair, width: 1, style: 3, labelBackgroundColor: p.up },
    },
    handleScroll: true,
    handleScale: true,
  };
}

/**
 * REQUIRED BY THE LICENCE. lightweight-charts is Apache-2.0 with an attribution notice: any public
 * use must visibly credit TradingView. It is exported as a constant so there is exactly one string
 * and a test can assert every chart surface renders it.
 */
export const CHART_ATTRIBUTION = 'Charts by TradingView';
export const CHART_ATTRIBUTION_HREF = 'https://www.tradingview.com/lightweight-charts/';
