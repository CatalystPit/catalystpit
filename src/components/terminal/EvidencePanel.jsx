'use client';
import { useEffect, useRef, useState } from 'react';
import { C, Dot, TickerLogo } from '../../lib/cp-shared';

// THE TERMINAL'S EVIDENCE INSPECTOR.
//
// ── ⚠️ ANOTHER CONSUMER, NOT ANOTHER ENGINE ─────────────────────────────────
//
// This reads /api/consensus — the same canonical endpoint the ticker page's Pit Consensus reads. It
// computes nothing, interprets nothing and holds no thresholds. Every state word, every family
// verdict and every reason below was produced by the canonical engine and is reproduced verbatim,
// which is the only way this panel and the ticker page can be guaranteed to agree. A second
// interpretation here would be a second product with the same name.
//
// ── ⚠️ AN INSPECTOR, NOT A SECOND TICKER PAGE ───────────────────────────────
//
// It answers four questions and stops: what changed, why is this ticker here, what else is there,
// and where do I verify it. Everything else the ticker page shows — the chart, the financials, the
// full filing history — is one explicit click away and stays there. A panel that grew into a copy
// of the ticker page would be slower, would drift from it, and would still be worse than it.
//
// ── ⚠️ ONE TICKER'S EVIDENCE NEVER APPEARS UNDER ANOTHER'S NAME ─────────────
//
// Two guards, because a trader clicking CDT then JAGX two seconds later is the normal case. The
// request captures the symbol it was made for and is discarded if a newer one has been selected;
// and the rendered payload is only shown when the symbol it names matches the symbol requested. The
// second is what covers the render, not just the fetch.

/** Bounded, in-session. Small on purpose: this covers a rotation, not a research history. */
const MAX_CACHED = 12;
const TTL_MS = 120_000;
const cache = new Map();

function cacheGet(sym, now = Date.now()) {
  const hit = cache.get(sym);
  if (!hit) return null;
  if (now - hit.at > TTL_MS) return null;
  cache.delete(sym); cache.set(sym, hit);      // LRU: a read is a use
  return hit.data;
}
function cachePut(sym, data, now = Date.now()) {
  if (!sym || !data) return;
  if (cache.has(sym)) cache.delete(sym);
  cache.set(sym, { data, at: now });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
}

const FAMILY_LABEL = {
  insiders: 'Insiders', institutions: 'Institutions', congress: 'Congress',
  catalysts: 'Catalysts · SEC · Wire', catalyst: 'Catalysts · SEC · Wire',
  price: 'Price', options: 'Options',
};

const DIR_TONE = (d) => (d > 0.05 ? C.green : d < -0.05 ? C.red : C.muted);

const Label = ({ children }) => (
  <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, letterSpacing: '1px', color: C.dim, marginBottom: 5 }}>
    {children}
  </div>
);

function Family({ f }) {
  const name = FAMILY_LABEL[f.family] || String(f.family || '').toUpperCase();
  const reasons = Array.isArray(f.reasons) ? f.reasons : [];
  return (
    <div style={{ padding: '8px 0', borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: f.active ? C.ink : C.dim }}>{name}</span>
        {/* The engine's own state word, not a rephrasing of it. */}
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.4px', color: DIR_TONE(Number(f.D)) }}>
          {f.state || (f.active ? 'active' : 'inactive')}
        </span>
        {f.evidenceCount > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 9.5, color: C.dim }}>
            {f.evidenceCount} item{f.evidenceCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {/* ⚠️ THE REASONS ARE THE PRODUCT. They are the canonical engine's own sentences and are
          printed unedited — summarising them here would be interpretation, which is the one thing
          this panel must not do. */}
      {reasons.slice(0, 3).map((r, i) => (
        <div key={i} style={{ fontSize: 11, color: C.muted, lineHeight: 1.45, marginTop: 3 }}>· {r}</div>
      ))}
      {!f.active && f.inactiveReason && (
        <div style={{ fontSize: 10.5, color: C.dim, marginTop: 3 }}>{f.inactiveReason}</div>
      )}
      {/* WHERE TO VERIFY IT. A ref is an accession number; it goes to the filing, not to us. */}
      {Array.isArray(f.refs) && f.refs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
          {f.refs.slice(0, 4).map((ref) => (
            <a key={ref} href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=&type=&dateb=&owner=include&count=40&search_text=${encodeURIComponent(ref)}`}
              target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 9.5, color: C.green, textDecoration: 'none', fontFamily: "'DM Sans',sans-serif",
                border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 5px' }}>
              {String(ref).slice(0, 20)}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default function EvidencePanel({ symbol }) {
  const [data, setData] = useState(null);
  const [state, setState] = useState('idle');     // idle | loading | ready | error
  const reqRef = useRef(0);

  useEffect(() => {
    const sym = symbol ? String(symbol).toUpperCase() : null;
    if (!sym) { setData(null); setState('idle'); return undefined; }

    // ⚠️ THE CACHE SHOWS THE RIGHT TICKER IMMEDIATELY OR SHOWS NOTHING. It is keyed by symbol, so a
    // hit is by definition this ticker's evidence; a miss clears the panel rather than leaving the
    // previous ticker's evidence on screen under the new name.
    const cached = cacheGet(sym);
    if (cached) { setData(cached); setState('ready'); } else { setData(null); setState('loading'); }

    let alive = true;
    const gen = ++reqRef.current;
    (async () => {
      try {
        const r = await fetch(`/api/consensus?ticker=${encodeURIComponent(sym)}`,
          { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
        const j = await r.json().catch(() => null);
        // ⚠️ A NEWER SELECTION WINS. CDT -> JAGX two seconds apart leaves both requests in flight and
        // they resolve in whatever order the network decides.
        if (!alive || gen !== reqRef.current) return;
        if (!r.ok || !j) { if (!cached) setState('error'); return; }
        cachePut(sym, j);
        setData(j);
        setState('ready');
      } catch {
        if (alive && gen === reqRef.current && !cached) setState('error');
      }
    })();
    return () => { alive = false; };
  }, [symbol]);

  const sym = symbol ? String(symbol).toUpperCase() : null;
  // ⚠️ THE SECOND GUARD, AND THE ONE THAT COVERS THE RENDER. Even with the request race handled, a
  // payload for the previous ticker must not be painted under this ticker's name for one frame.
  const shown = data && String(data.ticker || '').toUpperCase() === sym ? data : null;
  const families = (shown?.families || []).filter((f) => f && (f.active || (f.reasons || []).length));

  if (!sym) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: C.dim, lineHeight: 1.5 }}>
        Click <b style={{ color: C.muted }}>Evidence</b> on any Pit Scan row to inspect why that ticker is there — without leaving the Terminal.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px 14px', fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <TickerLogo symbol={sym} size={20} />
        <span className="cp-tkr" style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{sym}</span>
        {shown?.state && (
          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.7px', color: C.muted,
            border: `1px solid ${C.border2}`, borderRadius: 999, padding: '1px 8px' }}>
            {String(shown.state).replace(/_/g, ' ')}
          </span>
        )}
        {/* ⚠️ THE ONLY WAY OUT OF THE TERMINAL IS A DELIBERATE CLICK. That is the whole point of the
            panel: inspecting evidence must not cost a trader their workspace. */}
        <a href={`/ticker/${encodeURIComponent(sym)}`} target="_blank" rel="noopener noreferrer"
          style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: C.green, textDecoration: 'none', whiteSpace: 'nowrap' }}>
          Open full ticker →
        </a>
      </div>

      {state === 'loading' && !shown && (
        <div style={{ fontSize: 12, color: C.dim, padding: '12px 0' }}>Loading evidence for {sym}…</div>
      )}
      {state === 'error' && !shown && (
        <div style={{ fontSize: 12, color: C.muted, padding: '12px 0', lineHeight: 1.5 }}>
          Evidence for {sym} is unavailable right now. This is not a statement that there is none.
        </div>
      )}

      {shown && (
        <>
          {/* WHAT THE EVIDENCE ADDS UP TO — the canonical synthesis, in its own words. */}
          {shown.canonical && (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 10px', marginBottom: 8 }}>
              <Label>WHAT CHANGED</Label>
              <div style={{ fontSize: 12, color: C.ink, fontWeight: 600, lineHeight: 1.4 }}>
                {shown.canonical.headline || shown.canonical.label || String(shown.state || '').replace(/_/g, ' ')}
              </div>
              {shown.canonical.why && (
                <div style={{ fontSize: 11, color: C.muted, marginTop: 4, lineHeight: 1.45 }}>{shown.canonical.why}</div>
              )}
              {shown.canonical.confidence && (
                <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>
                  Confidence {shown.canonical.confidence}
                  {shown.calculatedAt ? ` · as of ${String(shown.calculatedAt).slice(0, 10)}` : ''}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10.5, color: C.muted }}>
              <b style={{ color: C.ink }}>{shown.activeCount ?? 0}</b> of {shown.evaluatedCount ?? 0} families active
            </span>
            {shown.agreement != null && (
              <span style={{ fontSize: 10.5, color: C.muted }}>agreement <b style={{ color: C.ink }}>{shown.agreement}</b></span>
            )}
            {Array.isArray(shown.conflicts) && shown.conflicts.length > 0 && (
              <span style={{ fontSize: 10.5, color: C.conflictAccent || C.red }}>{shown.conflicts.length} conflict{shown.conflicts.length === 1 ? '' : 's'}</span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <Dot /><span style={{ fontSize: 10.5, fontWeight: 700, color: C.ink, letterSpacing: '0.4px' }}>EVIDENCE BY FAMILY</span>
          </div>
          {families.length === 0 ? (
            <div style={{ fontSize: 11.5, color: C.muted, padding: '10px 0' }}>
              No family currently carries active evidence for {sym}.
            </div>
          ) : families.map((f, i) => <Family key={`${f.family}-${i}`} f={f} />)}
        </>
      )}
    </div>
  );
}
