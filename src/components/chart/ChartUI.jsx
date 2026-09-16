'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { palette } from '../../lib/chart/chart-theme.mjs';

// Shared chart UI primitives.
//
// Every menu, dropdown and modal on the chart is built from these three, so dismissal, focus and
// theming behave identically everywhere and adding the next menu is a call rather than another
// hand-rolled popover with its own subtly different Escape handling.

/**
 * Close on an outside click or Escape.
 *
 * Both, always. A popover that can only be dismissed by clicking its own trigger is a trap, and one
 * that ignores Escape is unusable from the keyboard.
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
export function ToolButton({ theme, active, onClick, title, children, width, danger, disabled }) {
  const p = palette(theme);
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} disabled={disabled}
      aria-pressed={active || undefined}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        minWidth: width || 26, height: 26, padding: width ? '0 8px' : 0, flexShrink: 0,
        background: active ? p.grid : 'transparent',
        border: `1px solid ${active ? p.up : 'transparent'}`,
        borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
        fontFamily: "'DM Sans',sans-serif", fontSize: 12, lineHeight: 1,
        color: danger ? p.down : (active ? p.textStrong : p.text),
      }}>{children}</button>
  );
}

/**
 * A button that opens a floating panel beneath it.
 *
 * `align` decides which edge the panel hangs from, because a menu on the right of a narrow panel
 * must not open off the edge of the chart.
 */
export function Dropdown({ theme, label, title, active, width = 200, align = 'left', children, buttonWidth }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const p = palette(theme);
  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <ToolButton theme={theme} active={active || open} onClick={() => setOpen((v) => !v)}
        title={title} width={buttonWidth}>{label}</ToolButton>
      {open && (
        <div
          onClick={(e) => { if (e.target.closest('[data-close-on-pick]')) close(); }}
          style={{
            position: 'absolute', top: '100%', marginTop: 4, zIndex: 40, width,
            [align]: 0,
            background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, borderRadius: 6,
            boxShadow: '0 8px 28px rgba(0,0,0,0.22)', padding: 5, maxHeight: 360, overflowY: 'auto',
          }}>{children}</div>
      )}
    </div>
  );
}

/** A row inside a Dropdown. `data-close-on-pick` lets the menu shut itself when one is chosen. */
export function MenuItem({ theme, onClick, active, children, right, closeOnPick = true }) {
  const p = palette(theme);
  return (
    <button type="button" onClick={onClick} {...(closeOnPick ? { 'data-close-on-pick': '' } : {})}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        background: active ? p.grid : 'transparent', border: 'none', borderRadius: 4,
        cursor: 'pointer', padding: '6px 8px',
        fontFamily: "'DM Sans',sans-serif", fontSize: 12,
        color: active ? p.textStrong : p.text, fontWeight: active ? 600 : 400,
      }}>
      <span style={{ flex: 1 }}>{children}</span>
      {right != null && <span style={{ color: p.text, opacity: 0.8, fontSize: 11 }}>{right}</span>}
    </button>
  );
}

/**
 * A centred modal.
 *
 * Fixed to the viewport rather than to the chart: in a Terminal panel a 260px-wide chart cannot
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
  if (!open) return null;
  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.42)',
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
    </div>
  );
}
