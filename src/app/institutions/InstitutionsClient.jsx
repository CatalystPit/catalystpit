'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { C, Dot, Skel, TopNav, Footer, BrandStyles } from '../../lib/cp-shared';

const fmtB = (n) => {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${Math.round(n).toLocaleString()}`;
};
const fmtQ = (s) => {
  if (!s) return '—';
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export default function InstitutionsClient() {
  const [funds, setFunds] = useState(null);
  const [admin, setAdmin] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState('');
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    (async () => {
      try { const r = await fetch('/api/institutions'); const j = r.ok ? await r.json() : null; if (alive) setFunds(j?.funds || []); }
      catch { if (alive) setFunds([]); }
    })();
    (async () => {
      try { const r = await fetch('/api/me/admin'); const j = r.ok ? await r.json() : null; if (alive) setAdmin(!!j?.admin); } catch {}
    })();
    return () => { alive = false; };
  }, []);

  // Admin: fill the whole slate by repeatedly running the bounded server ingest until nothing
  // remains (idempotent — completed funds are skipped, so later passes are fast).
  async function importAll() {
    if (importing) return;
    setImporting(true);
    for (let i = 0; i < 8; i++) {
      setProgress(`Import pass ${i + 1} — pulling 13F filings from SEC (up to a few minutes)…`);
      try { const r = await fetch('/api/cron/institutions'); await r.json().catch(() => ({})); } catch {}
      let remain = 0, loaded = 0;
      try {
        const lr = await fetch('/api/institutions');
        const lj = lr.ok ? await lr.json() : null;
        if (lj?.funds) { setFunds(lj.funds); loaded = lj.funds.filter((f) => f.hasData).length; remain = lj.funds.length - loaded; }
      } catch {}
      setProgress(`${loaded} funds loaded · ${remain} remaining`);
      if (remain === 0) break;
    }
    setImporting(false);
  }

  const cats = funds ? [...new Set(funds.map((f) => f.category))] : [];
  const missing = funds ? funds.filter((f) => !f.hasData).length : 0;

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Institutions" />

      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: '20px 24px' }}>
        <div style={{ maxWidth: 1380, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Dot /><span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.muted, letterSpacing: '1px' }}>FORM 13F-HR · SEC EDGAR</span>
          </div>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 32, fontWeight: 600, color: C.ink, margin: '0 0 4px', letterSpacing: '-0.5px' }}>Institutions</h1>
          <p style={{ fontSize: 13, color: C.muted, margin: 0, fontWeight: 300 }}>
            What the big managers hold, from quarterly 13F filings. Positions are reported up to 45 days after quarter-end — as-of dates shown per fund.
          </p>
          {admin && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button onClick={importAll} disabled={importing || missing === 0}
                style={{ background: C.green, border: 'none', color: '#fff', padding: '8px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                  cursor: (importing || missing === 0) ? 'default' : 'pointer', opacity: (importing || missing === 0) ? 0.6 : 1, fontFamily: "'DM Sans',sans-serif" }}>
                {importing ? 'Importing…' : missing === 0 ? 'All funds imported' : `Import all remaining (${missing})`}
              </button>
              {progress && <span style={{ fontSize: 12, color: C.muted, fontFamily: "'DM Sans',sans-serif" }}>{progress}</span>}
            </div>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 1380, margin: '20px auto', padding: '0 24px 48px' }}>
        {funds === null ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {Array(9).fill(0).map((_, i) => <div key={i} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}><Skel w="60%" h={16} mb={8} /><Skel w="40%" h={12} mb={0} /></div>)}
          </div>
        ) : cats.map((cat) => (
          <div key={cat} style={{ marginBottom: 26 }}>
            <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: '0.8px', marginBottom: 10 }}>{cat.toUpperCase()}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {funds.filter((f) => f.category === cat).map((f) => (
                <div key={f.slug} className="card-hov" onClick={() => router.push(`/institutions/${f.slug}`)}
                  style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '14px 16px', cursor: 'pointer', transition: 'all 0.2s', opacity: f.hasData ? 1 : 0.6 }}>
                  <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, color: C.ink }}>{f.label}</div>
                  <div style={{ fontSize: 12, color: C.muted, fontWeight: 300, marginBottom: 10 }}>{f.manager}</div>
                  {f.hasData ? (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                      <div>
                        <div className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 18, fontWeight: 700, color: C.green }}>{fmtB(f.totalValue)}</div>
                        <div style={{ fontSize: 10, color: C.dim }}>{(f.holdingsCount ?? 0).toLocaleString()} holdings · as of {fmtQ(f.quarter)}</div>
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: C.dim, fontStyle: 'italic' }}>Awaiting first filing import</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div style={{ fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
          "13F AUM" = long US-listed positions reported on Form 13F (excludes cash, shorts, bonds, and non-US holdings — not total firm AUM). Source: SEC EDGAR. Not financial advice.
        </div>
      </div>

      <Footer />
    </div>
  );
}
