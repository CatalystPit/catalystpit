'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { C, Skel, TopNav, Footer, BrandStyles, TickerLogo } from '../../../lib/cp-shared';
import {
  fmtMoney, fmtDate, partyStyle, chamberLabel, Avatar, Chip, Stat, actionStyle, fmtReturn, returnColor,
} from '../ui';

const COLS = [
  ['Ticker', 'left'], ['Company / Asset', 'left'], ['Traded', 'left'], ['Filed', 'left'],
  ['Lag', 'right'], ['Type', 'left'], ['Amount', 'right'], ['Return Since', 'right'],
];

export default function PoliticianDetail({ slug }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const router = useRouter();
  // Inert unless there's a real ticker — some FMP asset types have no symbol (renders "—").
  const goTicker = (sym) => { if (sym && sym !== '—') router.push(`/ticker/${encodeURIComponent(sym)}`); };

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError(null);
      try {
        const res = await fetch(`/api/politicians?slug=${encodeURIComponent(slug)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(json.error);
        if (alive) setData(json);
      } catch (e) {
        if (alive) { setError(e.message); setData(null); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [slug]);

  const member = data?.member;
  const trades = data?.trades || [];
  const ps = partyStyle(member?.party);

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Politicians" />

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 24px 40px' }}>
        <a href="/politicians" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.green, textDecoration: 'none' }}>← All politicians</a>

        {error ? (
          <div style={{ marginTop: 16, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '40px 16px', textAlign: 'center', color: C.red, fontSize: 13 }}>Failed to load: {error}</div>
        ) : loading ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20, display: 'flex', gap: 16, alignItems: 'center' }}>
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: C.surface, flexShrink: 0 }} />
              <div style={{ flex: 1 }}><Skel w="40%" h={18} mb={10} /><Skel w="55%" h={12} mb={0} /></div>
            </div>
            <div style={{ marginTop: 16, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
              {Array(8).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}
            </div>
          </div>
        ) : !member ? (
          <div style={{ marginTop: 16, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '40px 16px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No trades found for this member.</div>
        ) : (
          <>
            {/* HEADER CARD */}
            <div style={{ marginTop: 12, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                <Avatar photoUrl={member.photoUrl} name={member.name} ps={ps} size={72} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 28, fontWeight: 600, color: C.ink, margin: '0 0 6px' }}>{member.name || 'Unknown'}</h1>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Chip bg={ps.bg} fg={ps.fg}>{member.party || 'Unknown party'}</Chip>
                    {member.state && <Chip bg={C.surface} fg={C.muted}>{member.state}</Chip>}
                    <Chip bg={C.surface} fg={C.muted}>{chamberLabel(member.chamber)}</Chip>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginTop: 18, paddingTop: 16, borderTop: `1px solid ${C.surface}` }}>
                <Stat label="TRADES" value={member.tradeCount} />
                <Stat label="VOLUME" value={fmtMoney(member.totalVolume)} />
                <Stat label="LAST TRADED" value={fmtDate(member.lastTraded)} />
                <Stat label="AVG FILING LAG" value={member.avgFilingLag != null ? `${member.avgFilingLag}d` : '—'} />
                <Stat label="DISTINCT TICKERS" value={member.distinctTickers} />
              </div>
            </div>

            {/* TRADE HISTORY TABLE */}
            <div style={{ fontSize: 12, color: C.dim, fontFamily: "'DM Sans',sans-serif", margin: '18px 0 10px' }}>{trades.length} trades</div>
            <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                  <thead>
                    <tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                      {COLS.map(([h, al]) => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: al, fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap' }}>{h.toUpperCase()}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.length === 0 ? (
                      <tr><td colSpan={COLS.length} style={{ padding: '40px 16px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No trades.</td></tr>
                    ) : trades.map((t, i) => {
                      const as = actionStyle(t.action);
                      const late = t.filingLagDays != null && t.filingLagDays > 45;
                      return (
                        <tr key={t.id || i} className={t.ticker ? 'hov' : undefined} onClick={t.ticker ? () => goTicker(t.ticker) : undefined} style={{ borderBottom: i < trades.length - 1 ? `1px solid ${C.surface}` : 'none', borderLeft: `3px solid ${as.fg}` }}>
                          <td className="cp-tkr" style={{ padding: '12px 14px', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700, color: t.ticker ? C.green : C.dim, whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {t.ticker ? <><TickerLogo symbol={t.ticker} size={18} />{t.ticker}</> : '—'}
                              {t.optionType && <span style={{ fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 3, letterSpacing: '0.3px', background: t.optionType === 'Put' ? C.redLight : t.optionType === 'Call' ? C.greenLight : C.surface, color: t.optionType === 'Put' ? C.red : t.optionType === 'Call' ? C.green : C.muted }}>{t.optionType.toUpperCase()}</span>}
                            </span>
                          </td>
                          <td style={{ padding: '12px 14px', fontSize: 13, color: C.text, maxWidth: 280 }}>
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.assetName || t.assetDescription || '—'}</div>
                            {t.optionType && (t.strike || t.expiration || t.contracts) && (
                              <div style={{ fontSize: 10, color: C.muted, fontWeight: 300, marginTop: 2, whiteSpace: 'nowrap' }}>
                                {[t.contracts && `${Number(t.contracts).toLocaleString()} contracts`, t.strike && `$${t.strike} strike`, t.expiration && `exp ${t.expiration}`].filter(Boolean).join(' · ')}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '12px 14px', fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.muted, whiteSpace: 'nowrap' }}>{fmtDate(t.transactionDate)}</td>
                          <td style={{ padding: '12px 14px', fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.muted, whiteSpace: 'nowrap' }}>{fmtDate(t.disclosureDate)}</td>
                          <td style={{ padding: '12px 14px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: late ? C.red : C.muted, whiteSpace: 'nowrap' }}>{t.filingLagDays != null ? `${t.filingLagDays}d` : '—'}</td>
                          <td style={{ padding: '12px 14px' }}>
                            <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 4, fontFamily: "'DM Sans',sans-serif", fontWeight: 600, background: as.bg, color: as.fg }}>{t.action}</span>
                          </td>
                          <td className="cp-num" style={{ padding: '12px 14px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.text, whiteSpace: 'nowrap' }}>{t.amountRange || '—'}</td>
                          <td className="cp-num" style={{ padding: '12px 14px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700, color: returnColor(t.returnPct), whiteSpace: 'nowrap' }}>{fmtReturn(t.returnPct)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ marginTop: 16, fontSize: 11, color: C.dim, fontFamily: "'DM Sans',sans-serif", lineHeight: 1.6 }}>
              <strong style={{ color: C.muted }}>Return Since</strong> = change from the trade date&apos;s closing price to the latest price. &quot;—&quot; means price unavailable (not yet enriched, or a delisted/unlisted ticker) — never a substitute for a real 0%. Filing lag turns red when &gt; 45 days (STOCK Act deadline). Not financial advice.
            </div>
          </>
        )}
      </div>

      <Footer />
    </div>
  );
}
