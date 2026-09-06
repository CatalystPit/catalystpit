'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
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
// Options flag — a PUT is a bearish/short-style position, a CALL bullish. Never rendered as a
// long "buy" (a fund can be short a name via puts, e.g. Burry/PLTR).
function PC({ pc }) {
  if (!pc) return null;
  const put = /put/i.test(pc);
  return (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', padding: '1px 6px', borderRadius: 3, marginLeft: 6,
      background: put ? C.redLight : C.greenLight, color: put ? C.red : C.green }}>{pc.toUpperCase()}</span>
  );
}

// Holding-map tile: the company logo fills the box (no color fill); ticker + % on a strip below.
// Falls back to ticker/issuer text when there's no logo (unresolved, or FMP has no image).
function MapTile({ h, pct, flexGrow, onClick }) {
  const [failed, setFailed] = useState(false);
  const showLogo = h.ticker && !failed;
  return (
    <div onClick={onClick} title={`${h.ticker || h.issuer} · ${pct.toFixed(1)}%${h.putCall ? ' ' + h.putCall.toUpperCase() : ''}`}
      style={{ flexGrow: Math.max(flexGrow, 1), flexBasis: 120, minWidth: 104, height: 92, borderRadius: 6, overflow: 'hidden',
        position: 'relative', background: '#fff', border: `1px solid ${C.border}`, cursor: h.ticker ? 'pointer' : 'default' }}>
      {showLogo ? (
        <img src={`/api/logo?ticker=${encodeURIComponent(h.ticker)}`} alt={h.ticker} onError={() => setFailed(true)}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 22, width: '100%', height: 'calc(100% - 22px)', objectFit: 'contain', padding: '12px' }} />
      ) : (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 8px', textAlign: 'center' }}>
          <span className="cp-tkr" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: h.ticker ? 16 : 11, fontWeight: 700, color: C.ink, wordBreak: 'break-word' }}>{h.ticker || h.issuer}</span>
        </div>
      )}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 22, padding: '0 8px', background: 'rgba(12,20,16,0.85)', color: '#fff',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <span className="cp-tkr" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.ticker || ''}</span>
        <span className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>{pct.toFixed(1)}%{h.putCall ? ` ${h.putCall.toUpperCase()}` : ''}</span>
      </div>
    </div>
  );
}

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
            <PC pc={r.putCall} />
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
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const go = (t) => { if (t) router.push(`/ticker/${encodeURIComponent(t)}`); };

  async function runImport() {
    if (importing) return;
    setImporting(true);
    setImportMsg('Importing from SEC EDGAR — this can take up to a minute…');
    try {
      const r = await fetch(`/api/cron/institutions?fund=${encodeURIComponent(slug)}`);
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { setImportMsg('Please sign in to import this fund.'); return; }
      // The summary returns counts, not the holdings — reload the profile and let the data speak.
      const rr = await fetch(`/api/institutions?slug=${encodeURIComponent(slug)}`);
      const dd = rr.ok ? await rr.json() : null;
      const tr = j.tickersResolved;
      if (dd?.hasData) {
        setD(dd);
        setImportMsg(tr === 0 ? 'Imported ✓ — but 0 tickers resolved. Set OPENFIGI_API_KEY (free) in Vercel + re-import to get logos/links.' : `Imported ✓ — ${tr ?? '?'} tickers resolved.`);
      } else { if (dd) setD(dd); setImportMsg(`Import ran but no holdings landed — ${JSON.stringify(j)}`); }
    } catch (e) {
      setImportMsg(`Failed: ${e.message}`);
    } finally {
      setImporting(false);
    }
  }

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
            <div style={{ fontSize: 12, color: C.muted, fontWeight: 300, marginBottom: 16 }}>This manager&apos;s filing hasn&apos;t been imported yet.</div>
            {isSignedIn ? (
              <button onClick={runImport} disabled={importing}
                style={{ background: C.green, border: 'none', color: '#fff', padding: '10px 18px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                  cursor: importing ? 'default' : 'pointer', opacity: importing ? 0.7 : 1, fontFamily: "'DM Sans',sans-serif" }}>
                {importing ? 'Importing…' : 'Import this fund now'}
              </button>
            ) : (
              <div style={{ fontSize: 12, color: C.muted }}>Sign in to import this fund.</div>
            )}
            {importMsg && (
              <div style={{ marginTop: 14, fontSize: 12, color: C.muted, fontFamily: "'DM Sans',sans-serif", wordBreak: 'break-word', maxWidth: 560, marginLeft: 'auto', marginRight: 'auto' }}>{importMsg}</div>
            )}
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
                {holdings.slice(0, 30).map((h, i) => (
                  <MapTile key={i} h={h} pct={(h.value || 0) / shownTotal * 100} flexGrow={h.value || 1} onClick={() => go(h.ticker)} />
                ))}
              </div>
            </div>

            {/* activity */}
            <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
              <ActivityList title="New positions" rows={d.activity?.new || []} kind="new" />
              <ActivityList title="Increased" rows={d.activity?.added || []} kind="added" />
              <ActivityList title="Reduced" rows={d.activity?.trimmed || []} kind="trimmed" />
              <ActivityList title="Closed" rows={d.activity?.exited || []} kind="exited" />
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
                        <td style={{ padding: '10px 16px', fontSize: 13, color: C.text, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.issuer}<PC pc={h.putCall} /></td>
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
              13F positions as reported to the SEC (as of {fmtQ(d.latest?.quarter)}, filed {fmtQ(d.latest?.filedDate)}). Includes reported options — <b>PUT</b> = bearish, <b>CALL</b> = bullish (option positions on the underlying, not share ownership). Excludes cash, direct short sales, non-US and non-13F holdings. "% Port." is relative to the positions shown. Not financial advice.
            </div>
          </>
        )}
      </div>

      <Footer />
    </div>
  );
}
