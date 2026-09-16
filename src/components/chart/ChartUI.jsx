'use client';
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { palette } from '../../lib/chart/chart-theme.mjs';
// Placement is pure geometry and lives in .mjs so every panel size can be tested in node.
import { placeFor } from '../../lib/chart/chart-popover.mjs';

// Shared chart UI primitives.
//
// Every menu, flyout and modal on the chart is built from these, so dismissal, focus, placement and
// theming behave identically everywhere and adding the next menu is a call rather than another
// hand-rolled popover with its own subtly different Escape handling.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY EVERY MENU IS PORTALLED TO document.body
//
// The chart lives inside a Terminal panel, and that panel is `overflow: hidden` with a rounded
// border — on the panel shell AND again on its content area (see TerminalClient). An absolutely
// positioned menu inside the chart is therefore CLIPPED BY THE PANEL: in a small or freshly resized
// panel the chart-type menu was cut off mid-row, or disappeared entirely, because the panel's box
// ended before the menu did. `position: fixed` alone does not save it either — a fixed child is
// still clipped once an ancestor establishes a containing block, and these panels are drag-placed.
//
// So the panel is escaped entirely: menus render into document.body through a portal and position
// themselves in VIEWPORT coordinates taken from the trigger's bounding rect, then re-measure on
// scroll, on resize and on any change to the trigger. They stay visually pinned to their icon while
// being clipped by nothing but the window.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// Above the fullscreen chart (200) and anything the Terminal panels use, matching the convention the
// Insiders and Institutions portals already established in this codebase.
const POPOVER_Z = 2147482000;
const MODAL_Z = 2147482600;
// useLayoutEffect warns during SSR; placement must still run pre-paint in the browser so a menu
// never appears at 0,0 for a frame.
const useIsoLayout = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Open popover panels, innermost last.
 *
 * NESTED MENUS NEED THIS. In a narrow panel the rail collapses to one button whose menu contains the
 * category buttons, and a category flyout opens FROM inside that menu. Both are portalled to
 * document.body, so they are DOM siblings: a click in the flyout looks like an outside click to the
 * menu that spawned it, and the parent would slam shut underneath the child. Comparing stack
 * positions instead of DOM ancestry fixes it — a click inside any popover opened at or after mine is
 * not "outside" me. Escape likewise closes only the topmost.
 */
const openPanels = [];

/**
 * A floating panel anchored to a trigger element, rendered through a portal.
 *
 * Controlled: the caller owns `open`, so a trigger can be anything — a plain button, a button with
 * its own sub-button, a rail icon. Dismissal (outside click, Escape) is handled here so it behaves
 * identically everywhere; the anchor is excluded from "outside" so its own click still toggles.
 */
export function Popover({
  anchorRef, open, onClose, theme, children,
  placement = 'bottom-start', gap = 4, width = 200, maxHeight = 360, label,
}) {
  const [pos, setPos] = useState(null);
  const panelRef = useRef(null);
  const p = palette(theme);

  const place = useCallback(() => {
    const a = anchorRef.current;
    if (!a) return;
    setPos(placeFor(a.getBoundingClientRect(), placement, { gap, width, maxHeight }));
  }, [anchorRef, placement, gap, width, maxHeight]);

  useIsoLayout(() => { if (open) place(); else setPos(null); }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    // Capture phase, so this catches scrolling of ANY ancestor container and not just the window —
    // a Terminal panel body scrolls, and the menu has to follow its icon when it does.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    // A panel is also resized by dragging its corner, which moves the icon without firing either.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (ro) {
      if (anchorRef.current) ro.observe(anchorRef.current);
      if (document.body) ro.observe(document.body);
    }
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      if (ro) ro.disconnect();
    };
  }, [open, place, anchorRef]);

  // Join the stack while open, leave on close — order of open, not order in the DOM.
  useEffect(() => {
    if (!open) return undefined;
    const el = panelRef.current;
    if (el) openPanels.push(el);
    return () => { const i = openPanels.indexOf(el); if (i !== -1) openPanels.splice(i, 1); };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (anchorRef.current?.contains(e.target)) return;   // the trigger toggles itself
      const mine = openPanels.indexOf(panelRef.current);
      const hit = openPanels.findIndex((el) => el.contains(e.target));
      if (hit !== -1 && hit >= mine) return;               // inside me, or inside a menu I spawned
      onClose();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Only the innermost menu closes, so Escape peels one layer at a time.
      if (openPanels.length && openPanels[openPanels.length - 1] !== panelRef.current) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, onClose, anchorRef]);

  // NOTHING RENDERS UNTIL IT HAS BEEN PLACED. `place` runs in a layout effect, so the positioned
  // render still happens before paint and there is no visible jump — while a panel whose anchor is
  // missing (the style flyout can be opened by selecting a drawing while the collapsed rail's menu
  // is shut) is simply not mounted, rather than stranded off-screen swallowing the next Escape.
  if (!open || !pos || typeof document === 'undefined') return null;

  return createPortal(
    <div ref={panelRef} role="menu" aria-label={label}
      // A row marked data-close-on-pick shuts the menu, so picking a chart type applies AND closes in
      // one click without every menu having to wire that up itself.
      onClick={(e) => { if (e.target.closest?.('[data-close-on-pick]')) onClose(); }}
      style={{
        position: 'fixed',
        top: pos.top, left: pos.left, right: pos.right, bottom: pos.bottom,
        width: pos.width, maxHeight: pos.maxHeight,
        zIndex: POPOVER_Z, overflowY: 'auto', overflowX: 'hidden',
        background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, borderRadius: 8,
        boxShadow: '0 10px 32px rgba(0,0,0,0.26)', padding: 4,
      }}>{children}</div>,
    document.body,
  );
}

/**
 * Close on an outside click or Escape.
 *
 * Both, always. A popover that can only be dismissed by clicking its own trigger is a trap, and one
 * that ignores Escape is unusable from the keyboard. Kept for panels that are not `Popover`s.
 */
export function useDismiss(open, onClose) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);
  return ref;
}

/** A toolbar button. One definition, so every control on the chart looks and behaves the same. */
export function ToolButton({
  theme, active, onClick, title, children, width, danger, disabled, anchorRef, expanded,
}) {
  const [hover, setHover] = useState(false);
  const p = palette(theme);
  return (
    <button ref={anchorRef} type="button" onClick={onClick} title={title} aria-label={title}
      disabled={disabled} aria-pressed={active || undefined}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
      aria-expanded={expanded === undefined ? undefined : !!expanded}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        minWidth: width || 26, height: 26, padding: width ? '0 8px' : 0, flexShrink: 0,
        background: active ? p.menuActive : (hover && !disabled ? p.menuHover : 'transparent'),
        border: `1px solid ${active ? p.up : 'transparent'}`,
        borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
        fontFamily: "'DM Sans',sans-serif", fontSize: 12, lineHeight: 1,
        color: danger ? p.down : (active ? p.textStrong : p.text),
        transition: 'background 90ms ease',
      }}>{children}</button>
  );
}

/**
 * A button that opens an anchored menu directly beneath it.
 *
 * `align: 'right'` hangs the menu from the control's right edge, because a control on the right of a
 * narrow panel must not open off the edge of the window.
 */
export function Dropdown({
  theme, label, title, active, width = 200, align = 'left', children, buttonWidth, menuLabel,
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <ToolButton anchorRef={anchorRef} theme={theme} active={active || open} expanded={open}
        onClick={() => setOpen((v) => !v)} title={title} width={buttonWidth}>{label}</ToolButton>
      <Popover anchorRef={anchorRef} open={open} onClose={close} theme={theme} width={width}
        label={menuLabel || title} placement={align === 'right' ? 'bottom-end' : 'bottom-start'}>
        {children}
      </Popover>
    </>
  );
}

/** A small heading inside a menu, for flyouts that name their group. */
export function MenuLabel({ theme, children }) {
  const p = palette(theme);
  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, color: p.text, opacity: 0.85,
      padding: '4px 8px 5px', letterSpacing: '0.6px' }}>{String(children).toUpperCase()}</div>
  );
}

/**
 * A row inside a menu.
 *
 * `left` is a leading icon (fixed-width, so labels line up however wide the icons are); `right` is a
 * trailing hint such as a keyboard shortcut. `data-close-on-pick` lets the menu shut itself when a
 * row is chosen.
 *
 * THE SELECTED ROW IS MARKED THREE WAYS — a tinted background, an accent bar down its leading edge
 * and a trailing check — because a tint alone is easy to miss at this size, and the check is what a
 * screen reader and a colour-blind user actually get.
 */
export function MenuItem({
  theme, onClick, active, children, left, right, closeOnPick = true, disabled,
  // A one-of-many pick by default (chart type, drawing tool). Toggles pass 'menuitemcheckbox' and
  // plain commands pass 'menuitem', which takes no checked state at all.
  role = 'menuitemradio',
}) {
  const [hover, setHover] = useState(false);
  const p = palette(theme);
  return (
    <button type="button" onClick={disabled ? undefined : onClick} role={role}
      aria-checked={role === 'menuitem' ? undefined : !!active} disabled={disabled}
      {...(closeOnPick && !disabled ? { 'data-close-on-pick': '' } : {})}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
        background: active ? p.menuActive : (hover && !disabled ? p.menuHover : 'transparent'),
        border: 'none', borderRadius: 5,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
        padding: '7px 9px 7px 10px',
        fontFamily: "'DM Sans',sans-serif", fontSize: 12.5, lineHeight: 1.2,
        color: active ? p.textStrong : p.text, fontWeight: active ? 600 : 400,
        transition: 'background 90ms ease',
      }}>
      {active && (
        <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 5, bottom: 5, width: 2.5,
          borderRadius: 2, background: p.up }} />
      )}
      {left != null && (
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 16, flexShrink: 0, color: active ? p.up : p.text }}>{left}</span>
      )}
      <span style={{ flex: 1 }}>{children}</span>
      {right != null && <span style={{ color: p.text, opacity: 0.8, fontSize: 11 }}>{right}</span>}
      {active && right == null && (
        <span aria-hidden="true" style={{ color: p.up, fontSize: 11, fontWeight: 700 }}>✓</span>
      )}
    </button>
  );
}

/**
 * A centred modal, portalled for the same reason the menus are.
 *
 * Fixed to the VIEWPORT rather than to the chart: in a Terminal panel a 260px-wide chart cannot
 * contain a usable browser, and a modal clipped by its own panel is worse than one that overlays the
 * workspace. Escape and a backdrop click both close it.
 */
export function Modal({ theme, open, onClose, title, width = 460, children }) {
  const p = palette(theme);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: MODAL_Z, background: 'rgba(0,0,0,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}>
      <div role="dialog" aria-modal="true" aria-label={title}
        style={{
          width: '100%', maxWidth: width, maxHeight: '82vh', display: 'flex', flexDirection: 'column',
          background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, borderRadius: 8,
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)', overflow: 'hidden',
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
          borderBottom: `1px solid ${p.border}` }}>
          <span style={{ flex: 1, fontFamily: "'DM Sans',sans-serif", fontSize: 13,
            fontWeight: 600, color: p.textStrong }}>{title}</span>
          <ToolButton theme={theme} onClick={onClose} title="Close">✕</ToolButton>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A 16×16 icon drawn from registry data rather than from a glyph.
 *
 * WHY DATA AND NOT JSX: the chart-type registry is a plain .mjs module with no React in it, and that
 * is what lets the pure logic be tested in node. So an entry describes its icon as primitives —
 * ['rect', {...}], ['line', {...}], ['polyline', {...}], ['polygon', {...}] — and this renders them.
 * Adding a chart type stays ONE registry entry: it brings its own icon with it.
 *
 * Strokes and fills use currentColor, so an icon picks up the button's active/inactive colour
 * automatically and needs no theme plumbing. `faint` is the area fill, which must not read as solid.
 */
export function VectorIcon({ shapes, glyph, size = 14, title }) {
  if (!Array.isArray(shapes) || shapes.length === 0) {
    return <span aria-hidden="true">{glyph ?? '·'}</span>;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false"
      style={{ display: 'block', flexShrink: 0 }}>
      {title && <title>{title}</title>}
      {shapes.map(([kind, a], i) => {
        const paint = {
          stroke: 'currentColor',
          strokeWidth: a.strokeWidth ?? 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          fill: a.fill ? 'currentColor' : 'none',
          fillOpacity: a.fill ? (a.faint ? 0.22 : 1) : undefined,
        };
        const key = `${kind}-${i}`;
        if (kind === 'line') return <line key={key} x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} {...paint} />;
        if (kind === 'rect') return <rect key={key} x={a.x} y={a.y} width={a.width} height={a.height} rx={0.5} {...paint} />;
        if (kind === 'polyline') return <polyline key={key} points={a.points} {...paint} fill="none" fillOpacity={undefined} />;
        if (kind === 'polygon') return <polygon key={key} points={a.points} {...paint} stroke="none" />;
        return null;
      })}
    </svg>
  );
}
