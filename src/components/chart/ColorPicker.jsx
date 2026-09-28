'use client';
import { useState, useRef, useEffect, useMemo } from 'react';
import { palette, indicatorColor, indicatorColors } from '../../lib/chart/chart-theme.mjs';
import {
  COMMON_COLORS, normalizeHex, isValidHex, paletteMetrics, sizingForPointer,
} from '../../lib/chart/color-palette.mjs';

// THE COLOUR CONTROL — one palette, in one of two boxes.
//
// This module exports two things, and the split matters:
//
//   ColorPalettePanel  the ninety swatches, the themed six and the custom controls. Content only: no
//                      border, no background, no position. Whoever mounts it supplies the box.
//   ColorPicker        a self-contained trigger-plus-popover around that panel, for the places that
//                      want a swatch button they can drop into a row of settings.
//
// ⚠️ ONE CONTROL, NOT ONE PER INDICATOR. SMA, EMA, VWAP, RSI, ATR, each Bollinger band and each MACD
// series all render this. That is the point: a palette implemented per indicator is a palette that
// drifts, and the old six-swatch row was already duplicated in three other places in the chart UI.
//
// ⚠️ AND THE DRAWING TOOLBAR MOUNTS THE PANEL DIRECTLY, not a ColorPicker. It used to put a COMPACT
// ColorPicker inside a Popover, which meant a popover whose only content was another popover's
// trigger: one tap gave you a small box with a single blue square in it, and the palette needed a
// second tap on a caret a few pixels wide. See the note on ColorPalettePanel for why the toolbar
// cannot simply render ColorPicker's own panel instead.
//
// THE COLLAPSED STATE IS A ROW OF COMMON COLOURS plus the current swatch. Clicking the swatch opens
// the full grid — ninety shades across eight families and a grayscale ramp — with a hex field at the
// bottom for anything the grid does not carry. The common row means the ordinary case never needs the
// popover, and the popover means the palette is not limited to what fits on one line.
//
// ⚠️ A STORED VALUE MAY BE AN INDEX OR A HEX, and this control never has to care which: it compares
// against the RESOLVED colour, so a legacy index-2 instance shows the same swatch selected as one
// storing that colour explicitly. See chart-theme's indicatorColor.

const SWATCH = 15;
const GAP = 3;

// ⚠️ EVERY SIZE COMES FROM paletteMetrics(), IN color-palette.mjs. It used to be a set of constants
// here — GRID_SWATCH = 32, GRID_GAP = 4 — which meant the desktop and the phone got the same grid, and
// the numbers the tests asserted were literals restated in each suite. See the note over
// PALETTE_SIZINGS for why the choice is pointer kind rather than viewport width.

/**
 * Which sizing this client wants: dense for a cursor, large for a thumb.
 *
 * ⚠️ RESOLVED IN AN EFFECT AND DEFAULTED TO 'fine', NOT READ DURING RENDER. matchMedia during render
 * would disagree with the server's markup and make this a hydration mismatch. The effect runs when the
 * HOST mounts — the toolbar, the rail — which is long before anyone opens a palette, so by the time a
 * grid is drawn the answer is already correct and there is no visible re-size.
 */
export function usePaletteMetrics() {
  const [kind, setKind] = useState('fine');
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(pointer: coarse)');
    const apply = () => setKind(sizingForPointer(mq.matches));
    apply();
    // A pointer kind can change under you: a tablet gaining a mouse, a laptop's touchscreen.
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);
  return useMemo(() => paletteMetrics(kind), [kind]);
}

/** The desktop sizing, for a host that has not resolved a pointer kind yet. */
export const DEFAULT_PALETTE_METRICS = paletteMetrics('fine');

/** One swatch. Selection is a ring rather than a border, so it cannot change the colour it describes. */
function Swatch({ color, selected, onPick, title, size = SWATCH, p }) {
  return (
    <button
      type="button" title={title || color} aria-label={title || color}
      aria-pressed={selected}
      onClick={() => onPick(color)}
      style={{
        width: size, height: size, padding: 0, borderRadius: 3, cursor: 'pointer',
        boxSizing: 'border-box',
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
 * THE PALETTE ITSELF — the ninety swatches, the themed six, and the custom controls.
 *
 * ⚠️ WHY THIS IS A COMPONENT OF ITS OWN, AND WHY IT OWNS NO CHROME. It renders no border, no
 * background, no shadow and no position: it is content, and whoever mounts it supplies the box.
 *
 * That split is the fix for a real bug. The drawing toolbar's colour button opened a Popover whose
 * only content was a COMPACT ColorPicker — which is itself a trigger plus a popover. So the first tap
 * produced a small panel containing one blue square and a caret, and the palette needed a SECOND tap.
 * On a phone, where that caret is a few pixels wide, the palette was effectively unreachable.
 *
 * The obvious repair — render ColorPicker's own panel in the toolbar instead — does not work: that
 * panel is `position: absolute` inside the toolbar, and the toolbar lives inside the chart's
 * `overflow: hidden` box, so a 460px palette hung off a floating toolbar is clipped by the chart. The
 * panel has to be portalled out, which is what Popover already does for every other chart menu.
 *
 * Hence: the palette is content that either host can mount. ColorPicker wraps it in its own absolute
 * popover; the drawing toolbar hands it straight to Popover, whose portal is viewport-placed. One
 * implementation of the palette, two boxes to put it in — as opposed to two palettes, which is the
 * thing this whole component exists to prevent.
 *
 * @param {object} props
 * @param {string} props.theme  'light' | 'dark'
 * @param {number|string|null} props.value  the STORED value: a palette index, a hex, or null
 * @param {(v: string|number) => void} props.onPick    a deliberate choice; the host should dismiss
 * @param {(v: string|number) => void} props.onChange  a live edit; the host should stay open
 * @param {object} [props.metrics]  the sizing, from the HOST's usePaletteMetrics()
 */
export function ColorPalettePanel({ theme, value, onPick, onChange, metrics = DEFAULT_PALETTE_METRICS }) {
  const p = palette(theme);
  const m = metrics;
  const resolved = indicatorColor(theme, value);
  const [hex, setHex] = useState(resolved);

  // The field follows the value, so a colour changed from elsewhere never leaves a stale entry here.
  useEffect(() => { setHex(resolved); }, [resolved]);

  const pick = (c) => {
    const n = normalizeHex(c);
    if (n) onPick(n);
  };

  const commitHex = () => {
    const n = normalizeHex(hex);
    // An invalid entry reverts rather than being stored: a half-typed '#4A8' must not become a colour.
    if (n) onChange(n); else setHex(resolved);
  };

  return (
    <div
      data-cp-palette=""
      style={{
        display: 'flex', flexDirection: 'column', gap: m.stackGap,
        // ⚠️ THE GRID IS INSET BY THE SELECTION RING, ON BOTH SIDES. The panel used to be exactly as
        // wide as its grid, so the leftmost and rightmost columns sat flush against the content box —
        // measured in a real browser as 0.00px of padding either side. Two things went wrong with that.
        // The 2px selection outline, drawn 1px clear of the swatch, fell OUTSIDE the box and was cut off
        // by the popover's `overflow: hidden` whenever the chosen colour was in the purple column. And a
        // layout that fits to the pixel has nowhere to round, so under fractional display scaling the
        // last column loses a sliver. The inset is symmetrical, so both edge columns get the same gap.
        paddingLeft: m.ring, paddingRight: m.ring,
        // ⚠️ AND NOTHING TO SCROLL. The grid used to sit in a maxHeight with overflowY:auto, which put
        // ninety colours behind a scrollbar — choosing one then meant hunting for it. The 9x10 shape
        // exists so the entire palette is on screen at once, so there is nothing here to cap.
        width: m.contentWidth,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: m.gap }}>
        {m.grid.map((row, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} style={{ display: 'flex', gap: m.gap }}>
            {row.map((c) => (
              <Swatch key={c} p={p} color={c} title={c} size={m.swatch}
                selected={normalizeHex(c) === normalizeHex(resolved)} onPick={pick} />
            ))}
          </div>
        ))}
      </div>

      {/* ⚠️ THE THEMED SIX ARE STILL OFFERED. An instance storing a legacy index keeps swapping
          between the light and dark ramps, which an explicit hex cannot do — so the option to
          choose that behaviour has to remain reachable, not just survive in old saved state. */}
      <div style={{ borderTop: `1px solid ${p.border}`, paddingTop: m.sepPad }}>
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: m.labelFont, letterSpacing: '0.6px',
          color: p.text, marginBottom: 4, lineHeight: 1.45 }}>THEME-AWARE</div>
        <div style={{ display: 'flex', gap: m.gap }}>
          {indicatorColors(theme).map((c, i) => (
            <button
              key={c} type="button" title={`Theme color ${i + 1} (follows light and dark)`}
              aria-label={`Theme color ${i + 1}`}
              onClick={() => onPick(i)}
              style={{
                width: m.themeSwatch, height: m.themeSwatch, padding: 0, borderRadius: 3,
                cursor: 'pointer', boxSizing: 'border-box',
                background: c, border: `1px solid ${p.border}`,
                outline: value === i ? `2px solid ${p.textStrong}` : 'none', outlineOffset: 1,
              }}
            />
          ))}
        </div>
      </div>

      {/* Custom colour. The native input means nobody has to know hex to reach one. */}
      <div style={{ borderTop: `1px solid ${p.border}`, paddingTop: m.sepPad,
        display: 'flex', alignItems: 'center', gap: m.gap + 2 }}>
        <input
          type="color" aria-label="Custom color"
          value={resolved}
          onChange={(e) => onChange(normalizeHex(e.target.value) || resolved)}
          style={{ width: m.nativeW, height: m.nativeH, padding: 0, border: `1px solid ${p.border}`,
            borderRadius: 3, background: 'transparent', cursor: 'pointer', boxSizing: 'border-box',
            flexShrink: 0 }}
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
            width: m.hexWidth, height: m.hexInput, boxSizing: 'border-box', minWidth: 0,
            fontFamily: "'DM Sans',sans-serif", fontSize: m.kind === 'fine' ? 10 : 11,
            padding: '0 5px', borderRadius: 3, background: p.background,
            // An invalid entry is shown as invalid rather than silently ignored.
            border: `1px solid ${isValidHex(hex) ? p.border : p.down}`,
            color: p.textStrong,
          }}
        />
      </div>
    </div>
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
  const m = usePaletteMetrics();
  // The panel's own box: the content the palette needs, plus this popover's padding and 1px border.
  const panelWidth = m.contentWidth + m.hostPad * 2 + 2;
  const panelHeight = m.contentHeight + m.hostPad * 2 + 2;
  const resolved = indicatorColor(theme, value);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const panelRef = useRef(null);
  // Where the panel goes. Defaults to below-right and is corrected once it has been measured.
  const [place, setPlace] = useState({ vertical: 'below', horizontal: 'right', fits: true });

  /**
   * KEEP THE PANEL ON SCREEN.
   *
   * ⚠️ MEASURED, NOT ASSUMED. These controls appear in the drawing rail down the left edge, in the
   * drawing settings dialog and in the indicator browser, all of which reach the edges of the chart — so
   * a panel that always opens below and to the right opens off-screen, and ninety swatches become
   * unreachable. Runs after the panel mounts (it has no size before that), and again on resize and
   * scroll because a chart panel can be moved under a stationary popover.
   *
   * ⚠️ AND IT FLIPS WITHIN THE CHART, IT DOES NOT ESCAPE IT. This panel is `position: absolute`, so a
   * host inside an `overflow: hidden` box can still clip it when NEITHER side has room for the whole
   * palette — the flip picks the roomier side, which is the best a same-stacking-context panel can do.
   * The drawing toolbar needed better than that (it floats beside the drawing, anywhere in the plot), so
   * it mounts ColorPalettePanel in the portalled Popover instead, which is placed against the viewport.
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
      const ph = panel.offsetHeight || panelHeight;
      const pw = panel.offsetWidth || panelWidth;
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
  }, [open, panelWidth, panelHeight]);

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

  // A swatch or a themed colour is a final choice, so it applies AND shuts the panel. The hex field
  // and the native input go through onChange instead, which leaves the panel open — you are still
  // typing, and a panel that closed on the first keystroke could never be typed into.
  const pick = (v) => { onChange(v); setOpen(false); };
  const pickSwatch = (c) => { const n = normalizeHex(c); if (n) pick(n); };

  return (
    <div ref={boxRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: GAP }}>
      {/* The common shades, for the case that needs no popover. Each reads on both canvases. */}
      {!compact && COMMON_COLORS.map((c) => (
        <Swatch key={c} p={p} color={c} title={`Color ${c}`} size={m.themeSwatch}
          selected={normalizeHex(c) === normalizeHex(resolved)} onPick={pickSwatch} />
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
            // ⚠️ PLACED AGAINST THE VIEWPORT, NOT ALWAYS BELOW-RIGHT. These controls sit in a rail and
            // in settings panels that reach the EDGES of the chart, so a panel pinned to
            // top:100%/right:0 opened straight off-screen — 90 swatches clipped to nothing, with no way
            // to reach the one you wanted. `place` measures once the panel exists and flips it above or
            // to the left when there is not room, which is why it is state rather than a style guess.
            ...(place.vertical === 'above' ? { bottom: '100%', marginBottom: 4 } : { top: '100%', marginTop: 4 }),
            ...(place.horizontal === 'left' ? { left: 0 } : { right: 0 }),
            background: p.tooltipBg, border: `1px solid ${p.border}`, borderRadius: 6,
            padding: m.hostPad, boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
            width: panelWidth,
            boxSizing: 'border-box',
          }}
        >
          {/* The palette itself — the same component the drawing toolbar portals. */}
          <ColorPalettePanel theme={theme} value={value} onPick={pick} onChange={onChange}
            metrics={m} />
        </div>
      )}
    </div>
  );
}
