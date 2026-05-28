'use client';
import { useState } from 'react';
import { C } from '../../lib/cp-shared';

// Shared formatters + primitives for the /politicians LIST and DETAIL pages.

export const fmtMoney = (n) => {
  const v = Number(n);
  if (!v || isNaN(v)) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString('en-US')}`;
};

export const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const initials = (name) => {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};

// Democrat → blue, Republican → red, else neutral.
export const partyStyle = (party) => {
  const p = (party || '').toLowerCase();
  if (p.startsWith('democrat'))   return { bg: C.blueLight, fg: C.blue,  abbr: 'DEM' };
  if (p.startsWith('republican')) return { bg: C.redLight,  fg: C.red,   abbr: 'REP' };
  if (!party)                     return { bg: C.surface,   fg: C.dim,   abbr: '—'   };
  return { bg: C.surface, fg: C.muted, abbr: 'IND' };
};

export const chamberLabel = (c) => (c === 'senate' ? 'Senate' : c === 'house' ? 'House' : c || '—');

// BUY green / SELL red / other neutral.
export const actionStyle = (a) => {
  if (a === 'BUY')  return { fg: C.green, bg: C.greenLight };
  if (a === 'SELL') return { fg: C.red,   bg: C.redLight };
  return { fg: C.dim, bg: C.surface };
};

// returnPct: a number (incl. 0) → "+X.X%"/"-X.X%"/"0.0%"; null/undefined → "—".
// Keeps the honest-blank ("—", missing price) distinct from a real flat 0.0%.
export const fmtReturn = (r) => (r == null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(1)}%`);
export const returnColor = (r) => (r == null ? C.dim : r > 0 ? C.green : r < 0 ? C.red : C.muted);

export function Chip({ children, bg, fg }) {
  return (
    <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, fontWeight: 600, letterSpacing: '0.4px',
      background: bg, color: fg, padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap' }}>{children}</span>
  );
}

export function Avatar({ photoUrl, name, ps, size = 52 }) {
  const [failed, setFailed] = useState(false);
  if (photoUrl && !failed) {
    return (
      <img src={photoUrl} alt="" onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', objectPosition: 'center top',
          flexShrink: 0, border: `2px solid ${ps.bg}`, background: C.surface }} />
    );
  }
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center', background: ps.bg, color: ps.fg,
      fontFamily: "'DM Mono',monospace", fontWeight: 700, fontSize: Math.round(size * 0.3) }}>
      {initials(name)}
    </div>
  );
}

export function Stat({ label, value, small }) {
  return (
    <div>
      <div className="cp-num" style={{ fontFamily: "'DM Mono',monospace", fontWeight: 600,
        fontSize: small ? 12 : 16, color: C.ink }}>{value}</div>
      <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 9, color: C.dim, letterSpacing: '0.6px', marginTop: 2 }}>{label}</div>
    </div>
  );
}
