'use client';

// Top Catalysts — "what matters right now." Pulls news + press-release wires (/api/news) and 8-K
// filings (/api/eightk), scores each with the shared impact heuristic, and surfaces only the
// HIGH/NOTABLE ones, ranked. This is the product's editorial spine: open CatalystPit, see what moves.
import { useEffect, useState } from 'react';
import { C, Dot, TickerLogo, timeAgo, minsSince } from '../lib/cp-shared';
import { impactOf, IMPACT_RANK, IMPACT_STYLE } from '../lib/impact';

export default function TopCatalysts({ limit = 6 }) {
  const [items, setItems] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [newsRes, ekRes] = await Promise.all([
          fetch('/api/news', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch('/api/eightk?limit=40', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);

        const pool = [];
        for (const s of (newsRes?.data || [])) {
          pool.push({
            kind: 'news',
            title: s.title || s.headline || '',
            ticker: (s.ticker && s.ticker !== 'N/A') ? s.ticker : (s.sym || null),
            source: s.source || 'News',
            url: s.url || null,
            published: s.published || s.date || null,
            category: s.category || s.tag || '',
          });
        }
        for (const f of (ekRes?.list || [])) {
          pool.push({
            kind: '8-K',
            title: `${f.ticker} · ${f.primaryLabel}`,
            ticker: f.ticker,
            source: '8-K',
            url: f.url || null,
            published: f.filedAt || null,
            category: f.primaryLabel || '',
            material: f.material,
          });
        }

        // ── ONE EVENT, ONE CARD — AND THE FILING WINS ─────────────────────
        //
        // A results 8-K and the newswire story about it are the same event. Keyed on ticker and
        // title alone they never collided, so both appeared: the same company twice, once citing
        // SEC and once citing a wire, which reads as two things happening. They are now keyed on
        // TICKER + EVENT CLASS, and when they collide the 8-K survives — it is the primary
        // document, it is timestamped by EDGAR rather than by an editor, and its link goes to the
        // filing a trader can actually verify.
        const EVENT_CLASS = [
          [/delist|listing standard|listing compliance/, 'delist'],
          [/bankrupt|chapter 11|restructur/, 'bankruptcy'],
          [/acquir|merger|takeover|buyout|m&a/, 'ma'],
          [/offering|placement|notes|convertible|prices \$/, 'offering'],
          [/results|earnings|revenue|eps|guidance/, 'results'],
          [/ceo|cfo|officer|director|resign|appoint|steps down/, 'officer'],
          [/fda|clinical|phase \d|topline|endpoint/, 'clinical'],
          [/material agreement|agreement/, 'agreement'],
        ];
        const classOf = (p) => {
          const hay = `${p.title} ${p.category || ''}`.toLowerCase();
          for (const [re, name] of EVENT_CLASS) if (re.test(hay)) return name;
          return null;
        };

        const byKey = new Map();
        for (const p of pool) {
          if (!p.title) continue;
          const tier = impactOf(p);
          if (tier === 'routine') continue;
          const cls = classOf(p);
          // With no ticker or no recognisable class there is nothing to collapse against, so the
          // title keeps it distinct rather than silently merging two unrelated stories.
          const key = (p.ticker && cls)
            ? `${p.ticker}|${cls}`
            : `${p.ticker || ''}|${p.title.toLowerCase().slice(0, 40)}`;
          const prev = byKey.get(key);
          if (!prev) { byKey.set(key, { ...p, tier }); continue; }
          // SEC link wins. Otherwise keep whichever is higher-tier, then whichever is newer.
          const better = (prev.kind !== '8-K' && p.kind === '8-K')
            || (prev.kind === p.kind && IMPACT_RANK[tier] > IMPACT_RANK[prev.tier])
            || (prev.kind === p.kind && IMPACT_RANK[tier] === IMPACT_RANK[prev.tier]
                && new Date(p.published || 0) > new Date(prev.published || 0));
          if (better) byKey.set(key, { ...p, tier });
        }

        // ⚠️ A FILING OUTRANKS A FEATURE AT THE SAME TIER. Both may be HIGH, but one is the
        // company speaking on the record and the other is a publication writing about it.
        const scored = [...byKey.values()];
        scored.sort((a, b) => {
          if (IMPACT_RANK[b.tier] !== IMPACT_RANK[a.tier]) return IMPACT_RANK[b.tier] - IMPACT_RANK[a.tier];
          const aFiling = a.kind === '8-K' ? 1 : 0;
          const bFiling = b.kind === '8-K' ? 1 : 0;
          if (aFiling !== bFiling) return bFiling - aFiling;
          return new Date(b.published || 0) - new Date(a.published || 0);
        });
        if (alive) setItems(scored.slice(0, limit));
      } catch { if (alive) setItems([]); }
    })();
    return () => { alive = false; };
  }, [limit]);

  if (items && items.length === 0) return null;   // nothing high-impact → don't show an empty box

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', marginBottom: 14 }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot />
        <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>TOP CATALYSTS</span>
        <span style={{ fontSize: 9, color: C.muted, letterSpacing: '0.8px', marginLeft: 'auto' }}>WHAT MATTERS NOW</span>
      </div>
      <div style={{ padding: 8 }}>
        {items == null ? (
          <div style={{ padding: '18px 8px', textAlign: 'center', color: C.muted, fontSize: 12 }}>Scanning catalysts…</div>
        ) : (
          items.map((it, i) => {
            const st = IMPACT_STYLE[it.tier];
            const hasTicker = it.ticker && it.ticker !== '?';
            const row = (
              <div className="hov" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px',
                borderLeft: `3px solid ${it.tier === 'high' ? '#D64430' : '#D9A441'}`,
                borderBottom: i < items.length - 1 ? `1px solid ${C.surface}` : 'none' }}>
                {hasTicker ? <TickerLogo symbol={it.ticker} size={22} /> : <span style={{ width: 22 }} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    {st && <span style={{ fontSize: 9, fontWeight: 700, color: st.fg, background: st.bg, borderRadius: 3, padding: '1px 6px' }}>{st.label}</span>}
                    {hasTicker && <span className="cp-tkr" style={{ fontSize: 12, fontWeight: 700, color: C.green }}>{it.ticker}</span>}
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: C.muted, whiteSpace: 'nowrap' }}>
                      {it.source}{it.published ? <span className="cp-num"> · {timeAgo(minsSince(it.published))}</span> : null}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: C.ink, lineHeight: 1.3,
                    display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {it.title}
                  </div>
                </div>
              </div>
            );
            return it.url
              ? <a key={i} href={it.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>{row}</a>
              : <div key={i}>{row}</div>;
          })
        )}
      </div>
    </div>
  );
}
