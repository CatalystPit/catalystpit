'use client';
import { useState, useRef, useEffect } from 'react';
import { palette, indicatorColor, indicatorColors } from '../../lib/chart/chart-theme.mjs';
import {
  PALETTE_GRID, PALETTE_COLUMNS, PALETTE_ROWS, COMMON_COLORS, normalizeHex, isValidHex,
} from '../../lib/chart/color-palette.mjs';

// THE COLOUR CONTROL — one component, used by every indicator series.
//
// ⚠️ ONE CONTROL, NOT ONE PER INDICATOR. SMA, EMA, VWAP, RSI, ATR, each Bollinger band and each MACD
// series all render this. That is the point: a palette implemented per indicator is a palette that
// drifts, and the old six-swatch row was already duplicated in three other places in the chart UI.
//
// THE COLLAPSED STATE IS A ROW OF COMMON COLOURS plus the current swatch. Clicking the swatch opens
// the full grid — roughly ninety shades across ten families and a grayscale ramp — with a hex field at
// the bottom for anything the grid does not carry. The common row means the ordinary case never needs
// the popover, and the popover means the palette is not limited to what fits on one line.
//
// ⚠️ A STORED VALUE MAY BE AN INDEX OR A HEX, and this control never has to care which: it compares
// against the RESOLVED colour, so a legacy index-2 instance shows the same swatch selected as one
// storing that colour explicitly. See chart-theme's indicatorColor.

const SWATCH = 15;
const GAP = 3;
const PANEL_PAD = 8;
/** Grid swatches are slightly larger than the inline row: ten of them set the popover's width. */
const GRID_SWATCH = 18;
const GRID_GAP = 4;

/**
 * The panel's size, derived from the palette rather than guessed or measured.
 *
 * ⚠️ IT IS ALSO THE PROOF THE PANEL NEEDS NO SCROLLBAR. The whole grid is 9 rows of 10 at a known
 * swatch size, so its height is arithmetic rather than something the browser discovers — which is what
 * lets the placement decision happen before the first paint (see the placement effect) AND lets a test
 * assert the popover is tall enough to show all ninety without one.
 */
const PANEL_WIDTH = PALETTE_COLUMNS * GRID_SWATCH + (PALETTE_COLUMNS - 1) * GRID_GAP + PANEL_PAD * 2;
const GRID_HEIGHT = PALETTE_ROWS * GRID_SWATCH + (PALETTE_ROWS - 1) * GRID_GAP;
// The theme-aware row, the custom-colour row, and the two separators and gaps around them.
const EXTRAS_HEIGHT = 34 + 36 + 26;
const PANEL_HEIGHT_ESTIMATE = GRID_HEIGHT + EXTRAS_HEIGHT + PANEL_PAD * 2;
const PANEL_WIDTH_ESTIMATE = PANEL_WIDTH;

/** One swatch. Selection is a ring rather than a border, so it cannot change the colour it describes. */
function Swatch({ color, selected, onPick, title, size = SWATCH, p }) {
  return (
    <button
      type="button" title={title || color} aria-label={title || color}
      aria-pressed={selected}
      onClick={() => onPick(color)}
      style={{
        width: size, height: size, padding: 0, borderRadius: 3, cursor: 'pointer',
        background: color,
        // A hairline in the panel's own border colour keeps a white or near-black swatch visible
        // against the panel, without reading as a selection state.
        border: `1px solid ${p.border}`,
        outline: selected ? `2px solid ${p.textStrong}` : 'none',
        outlineOffset: 1,
        flexShrink: 0,
      }}
    />
  );
}

/**
 * @param {object}   props
 * @param {string}   props.theme      'light' | 'dark'
 * @param {number|string|null} props.value  the STORED value: a palette index, a hex, or null
 * @param {(v: string) => void} props.onChange  called with a canonical '#RRGGBB'
 * @param {string}   props.label      what this control colours, e.g. 'Upper band'
 * @param {boolean}  props.compact    hide the common row, show only the swatch
 */
export default function ColorPicker({ theme, value, onChange, label = 'Color', compact = false }) {
  const p = palette(theme);
  const resolved = indicatorColor(theme, value);
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(resolved);
  const boxRef = useRef(null);
  const panelRef = useRef(null);
  // Where the panel goes. Defaults to below-right and is corrected once it has been measured.
  const [place, setPlace] = useState({ vertical: 'below', horizontal: 'right', fits: true });

  /**
   * KEEP THE PANEL ON SCREEN.
   *
   * ⚠️ MEASURED, NOT ASSUMED. These controls appear in the drawing rail down the left edge and in the
   * floating toolbar that follows the selected drawing, both of which reach the edges of the chart — so
   * a panel that always opens below and to the right opens off-screen, and ninety swatches become
   * unreachable. Runs after the panel mounts (it has no size before that), and again on resize and
   * scroll because a chart panel can be moved under a stationary popover.
   */
  useEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const panel = panelRef.current;
      const anchor = boxRef.current;
      if (!panel || !anchor) return;
      const a = anchor.getBoundingClientRect();
      // ⚠️ AN ESTIMATE FIRST, THE MEASUREMENT SECOND. Reading offsetHeight alone meant the decision
      // depended on layout having already happened: on the very first pass it is 0, so the panel was
      // placed as if it were weightless and only corrected on a later pass — a visible flash at the
      // bottom of the chart, and untestable outside a real browser. The palette's size is known from
      // the palette itself, so the right side is chosen before anything is painted, and the measured
      // value refines it when there is one.
      const ph = panel.offsetHeight || PANEL_HEIGHT_ESTIMATE;
      const pw = panel.offsetWidth || PANEL_WIDTH_ESTIMATE;
      const vh = window.innerHeight || 0;
      const vw = window.innerWidth || 0;
      const PAD = 8;
      const below = vh - a.bottom - PAD;
      const above = a.top - PAD;
      // ⚠️ THE WHOLE PALETTE OR THE ROOMIER SIDE — never a shortened one. This used to cap the panel's
      // height to whatever room there was and let the grid scroll; the grid does not scroll any more, so
      // the only useful decision is which side actually fits it. Below is preferred when it fits, because
      // a menu opening downward is what a reader expects; otherwise above if IT fits; otherwise whichever
      // has more room, which is the best available answer in a viewport shorter than the palette.
      let vertical;
      if (ph <= below) vertical = 'below';
      else if (ph <= above) vertical = 'above';
      else vertical = above > below ? 'above' : 'below';
      // Right-aligned by default; flip to left-aligned when the panel would run off the left edge.
      const horizontal = (a.right - pw < PAD && a.left + pw < vw - PAD) ? 'left' : 'right';
      setPlace({ vertical, horizontal, fits: ph <= Math.max(above, below) });
    };
    measure();
    window.addEventListener('resize', measure);
    // ⚠️ A PAGE SCROLL CLOSES THIS, IT DOES NOT REPOSITION IT. This used to re-measure on scroll, which
    // dutifully kept a palette glued to the viewport while the chart it belongs to scrolled away — the
    // popover ended up floating over unrelated sections of the page, describing a drawing nobody could
    // see. Following the reader is the wrong instinct for a control that only means something next to
    // its chart. Capture phase, so a scroll in any ancestor counts.
    const onScroll = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // The field follows the value while the popover is shut, so reopening never shows a stale entry.
  useEffect(() => { if (!open) setHex(resolved); }, [resolved, open]);

  // ⚠️ CLOSES ON AN OUTSIDE CLICK, and on Escape. A popover that only closes by re-clicking its own
  // trigger is the kind that gets left open over the chart.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const pick = (c) => {
    const n = normalizeHex(c);
    if (!n) return;
    onChange(n);
    setOpen(false);
  };

  const commitHex = () => {
    const n = normalizeHex(hex);
    // An invalid entry reverts rather than being stored: a half-typed '#4A8' must not become a colour.
    if (n) onChange(n); else setHex(resolved);
  };

  return (
    <div ref={boxRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: GAP }}>
      {/* The common shades, for the case that needs no popover. Each reads on both canvases. */}
      {!compact && COMMON_COLORS.map((c) => (
        <Swatch key={c} p={p} color={c} title={`Color ${c}`}
          selected={normalizeHex(c) === normalizeHex(resolved)} onPick={pick} />
      ))}

      {/* The current colour, and the trigger. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`${label} — more colors`}
        aria-label={`${label} — more colors`}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
          background: p.tooltipBg, border: `1px solid ${open ? p.textStrong : p.border}`,
          borderRadius: 4, padding: '2px 4px', marginLeft: compact ? 0 : 4,
        }}
      >
        <span style={{ width: SWATCH, height: SWATCH, borderRadius: 3, background: resolved,
          border: `1px solid ${p.border}` }} />
        <span style={{ fontSize: 8, color: p.text, lineHeight: 1 }}>▾</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog" aria-label={`${label} palette`}
          data-cp-color-panel=""
          style={{
            position: 'absolute', zIndex: 40,
            // ⚠️ PLACED AGAINST THE VIEWPORT, NOT ALWAYS BELOW-RIGHT. These controls sit in a floating
            // toolbar and a rail that live at the EDGES of the chart, so a panel pinned to
            // top:100%/right:0 opened straight off-screen — 90 swatches clipped to nothing, with no way
            // to reach the one you wanted. `place` measures once the panel exists and flips it above or
            // to the left when there is not room, which is why it is state rather than a style guess.
            ...(place.vertical === 'above' ? { bottom: '100%', marginBottom: 4 } : { top: '100%', marginTop: 4 }),
            ...(place.horizontal === 'left' ? { left: 0 } : { right: 0 }),
            background: p.tooltipBg, border: `1px solid ${p.border}`, borderRadius: 6,
            padding: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
            display: 'flex', flexDirection: 'column', gap: 6,
            // ⚠️ A FIXED WIDTH AND NO SCROLLING, DELIBERATELY. The grid was inside a maxHeight with
            // overflowY:auto, which put ninety colours behind a scrollbar — choosing one then meant
            // hunting for it. The 9x10 shape exists so the entire palette is on screen at once, so
            // there is nothing here to cap and nothing to scroll.
            width: PANEL_WIDTH,
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: GRID_GAP }}>
            {PALETTE_GRID.map((row, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} style={{ display: 'flex', gap: GRID_GAP }}>
                {row.map((c) => (
                  <Swatch key={c} p={p} color={c} title={c} size={GRID_SWATCH}
                    selected={normalizeHex(c) === normalizeHex(resolved)} onPick={pick} />
                ))}
              </div>
            ))}
          </div>

          {/* ⚠️ THE THEMED SIX ARE STILL OFFERED. An instance storing a legacy index keeps swapping
              between the light and dark ramps, which an explicit hex cannot do — so the option to
              choose that behaviour has to remain reachable, not just survive in old saved state. */}
          <div style={{ borderTop: `1px solid ${p.border}`, paddingTop: 6 }}>
            <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, letterSpacing: '0.6px',
              color: p.text, marginBottom: 4 }}>THEME-AWARE</div>
            <div style={{ display: 'flex', gap: GAP }}>
              {indicatorColors(theme).map((c, i) => (
                <button
                  key={c} type="button" title={`Theme color ${i + 1} (follows light and dark)`}
                  aria-label={`Theme color ${i + 1}`}
                  onClick={() => { onChange(i); setOpen(false); }}
                  style={{
                    width: SWATCH, height: SWATCH, padding: 0, borderRadius: 3, cursor: 'pointer',
                    background: c, border: `1px solid ${p.border}`,
                    outline: value === i ? `2px solid ${p.textStrong}` : 'none', outlineOffset: 1,
                  }}
                />
              ))}
            </div>
          </div>

          {/* Custom colour. The native input means nobody has to know hex to reach one. */}
          <div style={{ borderTop: `1px solid ${p.border}`, paddingTop: 6,
            display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="color" aria-label="Custom color"
              value={indicatorColor(theme, value)}
              onChange={(e) => onChange(normalizeHex(e.target.value) || resolved)}
              style={{ width: 26, height: 22, padding: 0, border: `1px solid ${p.border}`,
                borderRadius: 3, background: 'transparent', cursor: 'pointer' }}
            />
            <input
              type="text" aria-label="Hex color" spellCheck={false} maxLength={7}
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              onBlur={commitHex}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitHex(); }
                // Typing in the field must not reach the chart's own key handlers.
                e.stopPropagation();
              }}
              placeholder="#RRGGBB"
              style={{
                width: 78, fontFamily: "'DM Sans',sans-serif", fontSize: 11,
                padding: '3px 5px', borderRadius: 3, background: p.background,
                // An invalid entry is shown as invalid rather than silently ignored.
                border: `1px solid ${isValidHex(hex) ? p.border : p.down}`,
                color: p.textStrong,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
