'use client';

// ConsensusBadge — shows on a ticker page when that name is currently on the Pit Consensus
// board (insiders + Congress + funds aligning). One-line pill linking to the full board.
import { useEffect, useState } from 'react';
import { C } from '../lib/cp-shared';

export default function ConsensusBadge({ symbol }) {
  const [hit, setHit] = useState(null);   // { dir, rank, score, signals }

  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/confluence?ticker=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (!alive || !j) return;
        // Prefer whichever side it ranks higher on (usually only one).
        const cands = [];
        if (j.bull) cands.push({ dir: 'bull', ...j.bull });
        if (j.bear) cands.push({ dir: 'bear', ...j.bear });
        cands.sort((a, b) => (b.score || 0) - (a.score || 0));
        setHit(cands[0] || null);
      } catch { /* silent — badge is optional chrome */ }
    })();
    return () => { alive = false; };
  }, [symbol]);

  if (!hit) return null;
  const bull = hit.dir === 'bull';
  const fg = bull ? C.green : C.red;
  const bg = bull ? C.greenLight : C.redLight;

  return (
    <a href="/consensus" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 10,
      background: bg, border: `1px solid ${bull ? C.greenBorder : '#E4B4B4'}`, borderRadius: 7,
      padding: '7px 12px', textDecoration: 'none' }}>
      <span style={{ fontSize: 13 }}>{bull ? '📈' : '📉'}</span>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: fg }}>
        Pit Consensus · {bull ? 'Accumulation' : 'Distribution'}
      </span>
      <span style={{ fontSize: 11, fontWeight: 600, color: fg, opacity: 0.85 }}>
        #{hit.rank} · {hit.signals}/3 signals · score {hit.score}
      </span>
      <span style={{ fontSize: 12, color: fg, fontWeight: 600 }}>→</span>
    </a>
  );
}
