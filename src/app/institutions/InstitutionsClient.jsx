'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { C, Dot, Skel, TopNav, Footer, BrandStyles, EntitySearch } from '../../lib/cp-shared';

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

function FundCard({ f, onClick }) {
  return (
    <div className="card-hov" onClick={onClick}
      style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '14px 16px', cursor: 'pointer', transition: 'all 0.2s', opacity: f.hasData ? 1 : 0.6 }}>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, color: C.ink }}>{f.label}</div>
      <div style={{ fontSize: 12, color: C.muted, fontWeight: 300, marginBottom: 10 }}>{f.manager || '13F filer'}</div>
      {f.hasData ? (
        <div>
          <div className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 18, fontWeight: 700, color: C.green }}>{fmtB(f.totalValue)}</div>
          <div style={{ fontSize: 10, color: C.dim }}>{(f.holdingsCount ?? 0).toLocaleString()} holdings · as of {fmtQ(f.quarter)}</div>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: C.dim, fontStyle: 'italic' }}>Awaiting first filing import</div>
      )}
    </div>
  );
}

export default function InstitutionsClient() {
  const [featured, setFeatured] = useState(null);
  const [dir, setDir] = useState({ items: [], total: 0, page: 0, pageSize: 48 });
  const [dirLoading, setDirLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [admin, setAdmin] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const router = useRouter();
  const debRef = useRef(null);

  const loadDir = useCallback(async (q, page) => {
    setDirLoading(true);
    try {
      const r = await fetch(`/api/institutions?q=${encodeURIComponent(q)}&page=${page}`);
      const j = r.ok ? await r.json() : null;
      setDir({ items: j?.directory || [], total: j?.total || 0, page: j?.page || 0, pageSize: j?.pageSize || 48 });
      if (featured === null) setFeatured(j?.featured || []);
    } catch { setDir({ items: [], total: 0, page: 0, pageSize: 48 }); }
    setDirLoading(false);
  }, [featured]);

  useEffect(() => {
    loadDir('', 0);
    (async () => { try { const r = await fetch('/api/me/admin'); const j = r.ok ? await r.json() : null; setAdmin(!!j?.admin); } catch {} })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search.
  function onSearch(v) {
    setQuery(v);
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => loadDir(v.trim(), 0), 280);
  }

  // Admin: run one bounded universe ingest pass (discovers filers + ingests a batch of holdings).
  async function runPass() {
    if (running) return;
    setRunning(true); setProgress('Running SEC 13F ingest pass (up to ~5 min)…');
    try {
      const r = await fetch('/api/cron/institutions-universe?indexes=2&ingestCap=200');
      const j = await r.json().catch(() => ({}));
      setProgress(j?.ok ? `Registered ${(j.registered || 0).toLocaleString()} filers · ingested ${j.ingestedNow || 0} this pass · ${(j.storedNow || 0).toLocaleString()} holdings stored` : 'Pass failed — check logs.');
      loadDir(query.trim(), dir.page);
    } catch { setProgress('Pass failed — check logs.'); }
    setRunning(false);
  }

  const cats = featured ? [...new Set(featured.map((f) => f.category))] : [];
  const pages = Math.max(1, Math.ceil(dir.total / (dir.pageSize || 48)));

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
          <p style={{ fontSize: 13, color: C.muted, margin: '0 0 14px', fontWeight: 300 }}>
            What the big managers hold, from quarterly 13F filings — every SEC 13F filer, auto-discovered. Positions are reported up to 45 days after quarter-end; as-of dates shown per fund.
          </p>
          <EntitySearch
            endpoint="/api/institutions?ac="
            placeholder="Search an institution by name…"
            width={420}
            hrefFor={(f) => `/institutions/${f.slug}`}
            renderRow={(f) => (
              <>
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.label}</span>
                  {f.manager && <span style={{ fontSize: 11, color: C.muted, fontWeight: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.manager}</span>}
                </span>
                {f.featured && <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', color: C.green, background: C.greenLight, padding: '2px 7px', borderRadius: 4, flexShrink: 0 }}>FEATURED</span>}
              </>
            )}
          />
          {admin && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button onClick={runPass} disabled={running}
                style={{ background: C.green, border: 'none', color: '#fff', padding: '8px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                  cursor: running ? 'default' : 'pointer', opacity: running ? 0.6 : 1, fontFamily: "'DM Sans',sans-serif" }}>
                {running ? 'Running…' : 'Run ingest pass'}
              </button>
              {progress && <span style={{ fontSize: 12, color: C.muted, fontFamily: "'DM Sans',sans-serif" }}>{progress}</span>}
            </div>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 1380, margin: '20px auto', padding: '0 24px 48px' }}>
        {/* Featured curated funds, grouped by category */}
        {featured === null ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {Array(9).fill(0).map((_, i) => <div key={i} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}><Skel w="60%" h={16} mb={8} /><Skel w="40%" h={12} mb={0} /></div>)}
          </div>
        ) : cats.map((cat) => (
          <div key={cat} style={{ marginBottom: 26 }}>
            <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: '0.8px', marginBottom: 10 }}>{(cat || 'Featured').toUpperCase()}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {featured.filter((f) => f.category === cat).map((f) => (
                <FundCard key={f.slug} f={f} onClick={() => router.push(`/institutions/${f.slug}`)} />
              ))}
            </div>
          </div>
        ))}

        {/* Full directory: every discovered 13F filer, searchable + paginated */}
        <div style={{ marginTop: 12, paddingTop: 22, borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            <div>
              <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, color: C.ink }}>All 13F filers</div>
              <div style={{ fontSize: 12, color: C.muted, fontWeight: 300 }}>{dir.total.toLocaleString()} manager{dir.total === 1 ? '' : 's'}{query ? ` matching “${query}”` : ' tracked'} · deepest coverage first</div>
            </div>
            <input value={query} onChange={(e) => onSearch(e.target.value)} placeholder="Search managers…"
              style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px', fontSize: 13, color: C.text, width: 260, maxWidth: '100%', fontFamily: "'DM Sans',sans-serif", outline: 'none' }} />
          </div>

          {dirLoading ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {Array(8).fill(0).map((_, i) => <div key={i} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}><Skel w="60%" h={16} mb={8} /><Skel w="40%" h={12} mb={0} /></div>)}
            </div>
          ) : dir.items.length === 0 ? (
            <div style={{ padding: '28px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
              {query ? `No managers match “${query}”.` : 'Directory is populating from SEC filings — check back shortly.'}
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
                {dir.items.map((f) => <FundCard key={f.slug} f={f} onClick={() => router.push(`/institutions/${f.slug}`)} />)}
              </div>
              {pages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 20 }}>
                  <button disabled={dir.page <= 0} onClick={() => loadDir(query.trim(), dir.page - 1)}
                    style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 14px', fontSize: 13, color: dir.page <= 0 ? C.dim : C.text, cursor: dir.page <= 0 ? 'default' : 'pointer', fontFamily: "'DM Sans',sans-serif" }}>← Prev</button>
                  <span style={{ fontSize: 12, color: C.muted, fontFamily: "'DM Sans',sans-serif" }}>Page {dir.page + 1} of {pages.toLocaleString()}</span>
                  <button disabled={dir.page >= pages - 1} onClick={() => loadDir(query.trim(), dir.page + 1)}
                    style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 14px', fontSize: 13, color: dir.page >= pages - 1 ? C.dim : C.text, cursor: dir.page >= pages - 1 ? 'default' : 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Next →</button>
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ marginTop: 26, fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
          "13F AUM" = long US-listed positions reported on Form 13F (excludes cash, shorts, bonds, and non-US holdings — not total firm AUM). Source: SEC EDGAR. Not financial advice.
        </div>
      </div>

      <Footer />
    </div>
  );
}
