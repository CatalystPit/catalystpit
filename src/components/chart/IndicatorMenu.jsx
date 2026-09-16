'use client';
import { useEffect, useRef, useState } from 'react';
import { INDICATORS, availableIndicators, defaultParams, sanitizeParams, indicatorLabel } from '../../lib/chart/chart-indicators.mjs';
import { palette, indicatorColor } from '../../lib/chart/chart-theme.mjs';

// Add, remove and configure indicators.
//
// Renders entirely from the registry — there is no per-indicator markup here, so a new entry in
// INDICATORS appears in this menu with its settings fields and needs no change to this file. That is
// the whole reason params are declared as data (type, min, max, default) rather than as JSX.

export default function IndicatorMenu({ theme, intraday, active, onChange }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const rootRef = useRef(null);
  const p = palette(theme);

  // Close on an outside click or Escape — a panel that traps the user is worse than no panel.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) { setOpen(false); setEditing(null); } };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setEditing(null); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const activeIds = new Set(active.map((a) => a.id));
  const list = availableIndicators({ intraday });

  const toggle = (id) => {
    onChange(activeIds.has(id)
      ? active.filter((a) => a.id !== id)
      : [...active, { id, params: defaultParams(id) }]);
  };
  const setParam = (id, key, value) => {
    onChange(active.map((a) => (a.id === id
      ? { ...a, params: sanitizeParams(id, { ...a.params, [key]: value }) }
      : a)));
  };

  const swatch = (id) => {
    const def = INDICATORS[id];
    const first = def?.colors ? Object.values(def.colors)[0] : null;
    return first == null ? null : (
      <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0,
        background: indicatorColor(theme, first) }} />
    );
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" onClick={() => setOpen((v) => !v)}
        style={{ background: 'transparent', border: `1px solid ${p.border}`, borderRadius: 4, cursor: 'pointer',
          padding: '3px 9px', fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text, whiteSpace: 'nowrap' }}>
        Indicators{active.length ? ` (${active.length})` : ''}
      </button>

      {open && (
        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 20, width: 236,
          background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, borderRadius: 6,
          boxShadow: '0 8px 28px rgba(0,0,0,0.20)', padding: 6, maxHeight: 340, overflowY: 'auto' }}>
          {list.map((def) => {
            const on = activeIds.has(def.id);
            const entry = active.find((a) => a.id === def.id);
            const isEditing = editing === def.id;
            return (
              <div key={def.id} style={{ borderRadius: 4, marginBottom: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 7px' }}>
                  <input type="checkbox" checked={on} onChange={() => toggle(def.id)}
                    style={{ cursor: 'pointer', accentColor: p.up, margin: 0 }} />
                  {swatch(def.id)}
                  <button type="button" onClick={() => toggle(def.id)}
                    style={{ flex: 1, textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer',
                      padding: 0, fontFamily: "'DM Sans',sans-serif", fontSize: 12,
                      color: on ? p.textStrong : p.text, fontWeight: on ? 600 : 400 }}>
                    {on && entry ? indicatorLabel(def.id, entry.params) : def.label}
                  </button>
                  {def.pane === 'separate' && (
                    <span style={{ fontSize: 8, letterSpacing: '0.5px', color: p.text, opacity: 0.7 }}>PANE</span>
                  )}
                  {on && def.params.length > 0 && (
                    <button type="button" onClick={() => setEditing(isEditing ? null : def.id)}
                      title="Settings"
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px',
                        color: p.text, fontSize: 12, lineHeight: 1 }}>⚙</button>
                  )}
                </div>

                {on && isEditing && (
                  <div style={{ padding: '2px 8px 8px 28px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {def.params.map((prm) => (
                      <label key={prm.key} style={{ display: 'flex', alignItems: 'center', gap: 6,
                        fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text }}>
                        <span style={{ flex: 1 }}>{prm.label}</span>
                        <input
                          type="number" min={prm.min} max={prm.max} step={prm.step || 1}
                          value={entry?.params?.[prm.key] ?? prm.default}
                          onChange={(e) => setParam(def.id, prm.key, e.target.value)}
                          style={{ width: 62, background: 'transparent', color: p.textStrong,
                            border: `1px solid ${p.border}`, borderRadius: 3, padding: '2px 5px',
                            fontFamily: "'DM Sans',sans-serif", fontSize: 11 }} />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Said plainly rather than by omission: VWAP is absent on a daily chart because a daily
              bar spans the whole session, not because the feature is missing. */}
          {!intraday && INDICATORS.vwap && (
            <div style={{ padding: '6px 7px 2px', fontFamily: "'DM Sans',sans-serif", fontSize: 10,
              color: p.text, opacity: 0.75, borderTop: `1px solid ${p.border}`, marginTop: 4 }}>
              VWAP needs intraday bars — switch to 1D or 5D.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
