'use client';
import { useEffect, useRef, useState } from 'react';
import { palette } from '../../lib/chart/chart-theme.mjs';

// The chart-level controls, collapsed into one menu.
//
// Used when the chart is too narrow to show them as buttons — a Terminal panel dragged small, or a
// phone. Deliberately the SAME controls rather than a reduced set: the answer to "not enough room"
// is to move them, not to take them away.
//
// CHART TYPE IS NOT HERE. It has its own compact icon control in the toolbar at every width, and a
// second selector in this menu would be both a duplicate and a worse one — the toggle this replaced
// flipped Candles/Line only, so it could not reach Area at all.

export default function ChartMenu({ theme, view, canExtend, onPatch, onReset }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const p = palette(theme);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const row = (label, value, onClick) => (
    <button key={label} type="button" onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent',
        border: 'none', cursor: 'pointer', padding: '5px 7px', borderRadius: 4,
        fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: p.text, textAlign: 'left' }}>
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ color: p.textStrong, fontWeight: 600 }}>{value}</span>
    </button>
  );

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} title="Chart settings" aria-label="Chart settings"
        style={{ background: 'transparent', border: `1px solid ${p.border}`, borderRadius: 4,
          cursor: 'pointer', padding: '3px 8px', fontFamily: "'DM Sans',sans-serif", fontSize: 12,
          color: p.text, lineHeight: 1.4 }}>⚙</button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 25, width: 176,
          background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, borderRadius: 6,
          boxShadow: '0 8px 28px rgba(0,0,0,0.22)', padding: 5 }}>
          {canExtend && row('Extended hours', view.extended ? 'On' : 'Off', () => onPatch({ extended: !view.extended }))}
          {row('Price scale', view.logScale ? 'Log' : 'Linear', () => onPatch({ logScale: !view.logScale }))}
          {row('Auto scale', view.autoScale ? 'On' : 'Off', () => onPatch({ autoScale: !view.autoScale }))}
          {row('Reset view', '', () => { onReset(); setOpen(false); })}
        </div>
      )}
    </div>
  );
}
