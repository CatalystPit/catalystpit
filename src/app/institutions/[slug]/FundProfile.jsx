'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { C, Dot, Skel, TopNav, Footer, BrandStyles, TickerLogo } from '../../../lib/cp-shared';

const fmtB = (n) => {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n).toLocaleString()}`;
};
const fmtSh = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString();
const fmtQ = (s) => {
  if (!s) return '—';
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const TILE_COLORS = ['#1E5C38', '#2A7848', '#1A3A78', '#3A5A9A', '#5A2A98', '#7A5818', '#1A5A58', '#8A4810'];

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.6px', marginBottom: 3 }}>{label}</div>
      <div className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 16, fontWeight: 700, color: C.ink }}>{value}</div>
    </div>
  );
}

function ActivityList({ title, rows, kind }) {
  const color = kind === 'exited' || kind === 'trimmed' ? C.red : C.green;
  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, background: C.surface, fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 700, color: C.ink }}>
        {title} <span style={{ color: C.dim, fontWeight: 400 }}>· {rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: '16px 14px', fontSize: 12, color: C.muted, fontWeight: 300 }}>None</div>
      ) : rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderBottom: i < rows.length - 1 ? `1px solid ${C.surface}` : 'none' }}>
          <TickerLogo symbol={r.ticker || ''} size={16} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <span className="cp-tkr" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 700, color: r.ticker ? C.green : C.text }}>{r.ticker || r.issuer}</span>
            {r.ticker && <span style={{ fontSize: 11, color: C.muted, fontWeight: 300, marginLeft: 6 }}>{r.issuer}</span>}
          </div>
          <span className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color, whiteSpace: 'nowrap' }}>
            {kind === 'exited' ? 'sold all' : kind === 'new' ? 'new' : `${fmtSh(r.prevShares)}→${fmtSh(r.shares)}`}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function FundProfile({ slug }) {
  const [d, setD] = useState(null);
  const router = useRouter();
  const go = (t) => { if (t) router.push(`/ticker/${encodeURIComponent(t)}`); };

  useEffect(() => {
    let alive = true;
    (async () => {
      try { const r = await fetch(`/api/institutions?slug=${encodeURIComponent(slug)}`); const j = r.ok ? await r.json() : { error: true }; if (alive) setD(j); }
      catch { if (alive) setD({ error: true }); }
    })();
    return () => { alive = false; };
  }, [slug]);

  const fund = d?.fund;
  const holdings = d?.holdings || [];
  const shownTotal = holdings.reduce((s, h) => s + (h.value || 0), 0) || 1;

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Institutions" />

      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: '20px 24px' }}>
        <div style={{ maxWidth: 1380, margin: '0 auto' }}>
          <a href="/institutions" style={{ fontSize: 12, color: C.green, textDecoration: 'none' }}>← All institutions</a>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600, color: C.ink, margin: '6px 0 2px', letterSpacing: '-0.5px' }}>
            {fund?.label || (d ? 'Fund' : '…')}
          </h1>
          <div style={{ fontSize: 13, color: C.muted, fontWeight: 300 }}>{fund?.manager}{fund?.category ? ` · ${fund.category}` : ''}</div>
        </div>
      </div>

      <div style={{ maxWidth: 1380, margin: '18px auto', padding: '0 24px 48px' }}>
        {!d ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>{Array(6).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}</div>
        ) : d.error || !fund ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center', color: C.muted }}>Fund not found.</div>
        ) : !d.hasData ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 4 }}>No 13F on file yet</div>
            <div style={{ fontSize: 12, color: C.muted, fontWeight: 300 }}>This manager&apos;s filing hasn&apos;t been imported yet — check back after the next ingest.</div>
          </div>
        ) : (
          <>
            {/* summary */}
            <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '18px 20px', display: 'flex', gap: 34, flexWrap: 'wrap' }}>
              <Stat label="13F PORTFOLIO VALUE" value={fmtB(d.latest?.totalValue)} />
              <Stat label="HOLDINGS" value={(d.totalHoldings ?? holdings.length).toLocaleString()} />
              <Stat label="AS OF" value={fmtQ(d.latest?.quarter)} />
              <Stat label="FILED" value={fmtQ(d.latest?.filedDate)} />
            </div>

            {/* holding map */}
            <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7 }}>
                <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Holding map</span>
                <span style={{ marginLeft: 'auto', fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontFamily: "'DM Sans',sans-serif" }}>TOP {Math.min(holdings.length, 30)} BY VALUE</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 12 }}>
                {holdings.slice(0, 30).map((h, i) => {
                  const pct = (h.value || 0) / shownTotal * 100;
                  return (
                    <div key={i} onClick={() => go(h.ticker)} title={`${h.ticker || h.issuer} · ${pct.toFixed(1)}%`}
                      style={{ flexGrow: Math.max(h.value || 1, 1), flexBasis: 96, minWidth: 84, height: 62, borderRadius: 5,
                        background: TILE_COLORS[i % TILE_COLORS.length], color: '#fff', padding: '8px 10px', cursor: h.ticker ? 'pointer' : 'default',
                        display: 'flex', flexDirection: 'column', justifyContent: 'space-between', overflow: 'hidden' }}>
                      <span className="cp-tkr" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.ticker || h.issuer}</span>
                      <span className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, opacity: 0.85 }}>{pct.toFixed(1)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* activity */}
            <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
              <ActivityList title="New buys" rows={d.activity?.new || []} kind="new" />
              <ActivityList title="Added" rows={d.activity?.added || []} kind="added" />
              <ActivityList title="Trimmed" rows={d.activity?.trimmed || []} kind="trimmed" />
              <ActivityList title="Exited" rows={d.activity?.exited || []} kind="exited" />
            </div>
            {!d.prior && <div style={{ marginTop: 8, fontSize: 11, color: C.dim, fontWeight: 300 }}>Quarter-over-quarter activity appears once a second quarter is imported.</div>}

            {/* holdings table */}
            <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7 }}>
                <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Holdings</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: C.dim }}>Top {holdings.length}{d.totalHoldings > holdings.length ? ` of ${d.totalHoldings.toLocaleString()}` : ''}</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                    {[['Ticker'], ['Company'], ['Shares', 'right'], ['Value', 'right'], ['% Port.', 'right']].map(([h, a]) => (
                      <th key={h} style={{ padding: '8px 16px', textAlign: a || 'left', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap' }}>{h.toUpperCase()}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {holdings.map((h, i) => (
                      <tr key={i} className={h.ticker ? 'hov' : undefined} onClick={() => go(h.ticker)} style={{ borderBottom: i < holdings.length - 1 ? `1px solid ${C.surface}` : 'none', cursor: h.ticker ? 'pointer' : 'default' }}>
                        <td style={{ padding: '10px 16px' }}><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><TickerLogo symbol={h.ticker || ''} size={18} /><span className="cp-tkr" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700, color: h.ticker ? C.green : C.dim }}>{h.ticker || '—'}</span></span></td>
                        <td style={{ padding: '10px 16px', fontSize: 13, color: C.text, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.issuer}{h.putCall ? ` (${h.putCall})` : ''}</td>
                        <td className="cp-num" style={{ padding: '10px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{fmtSh(h.shares)}</td>
                        <td className="cp-num" style={{ padding: '10px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, color: C.text, whiteSpace: 'nowrap' }}>{fmtB(h.value)}</td>
                        <td className="cp-num" style={{ padding: '10px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{((h.value || 0) / shownTotal * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ marginTop: 14, fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
              Long US-listed 13F positions as reported to the SEC (as of {fmtQ(d.latest?.quarter)}, filed {fmtQ(d.latest?.filedDate)}). Excludes cash, shorts, non-US and non-13F holdings. "% Port." is relative to the positions shown. Not financial advice.
            </div>
          </>
        )}
      </div>

      <Footer />
    </div>
  );
}
