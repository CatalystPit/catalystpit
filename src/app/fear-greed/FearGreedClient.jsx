'use client';
import { useState, useEffect, useCallback } from 'react';
import { C, Dot, TopNav, Footer, BrandStyles } from '../../lib/cp-shared';
import ErrorState from '../../components/ErrorState';
import FearGreedMeter from '../../components/FearGreedMeter';
import FearGreedHistory from '../../components/FearGreedHistory';

// CATALYST PIT FEAR & GREED — the page.
//
// ⚠️ THE COMPONENT TABLE IS NOT DECORATION. A single 0-100 number is a magic number unless the
// reader can see what produced it, and the interesting days are the ones where the components
// disagree — a board reading 39 with credit at 83 and breadth at 6 is telling a story that the
// headline number alone hides. The breakdown is the product, not an appendix to it.

const ZONE_COLOR = (label) => {
  if (label === 'EXTREME FEAR') return { fg: C.red, bg: C.redLight };
  if (label === 'FEAR') return { fg: C.red, bg: C.redLight };
  if (label === 'NEUTRAL') return { fg: C.muted, bg: C.surface };
  if (label === 'GREED') return { fg: C.green, bg: C.greenLight };
  if (label === 'EXTREME GREED') return { fg: C.green, bg: C.greenLight };
  return { fg: C.dim, bg: C.surface };
};

function Gauge({ score, zone, asOf }) {
  // ⚠️ A DIAL, NOT A BAR. The horizontal scale that used to live here made a reader measure a
  // proportion; the arc is read positionally — 39 is visibly left of centre, in the fear half,
  // before anyone reads a number. The drawing itself is FearGreedMeter.
  return (
    <div style={{ textAlign: 'center', padding: '24px 16px 18px' }}>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, letterSpacing: '1.6px', color: C.dim }}>
        CATALYST PIT
      </div>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, letterSpacing: '2.4px', color: C.muted, marginTop: 2, marginBottom: 6 }}>
        FEAR &amp; GREED
      </div>
      <FearGreedMeter score={score} zone={zone} asOf={asOf} />
    </div>
  );
}

function Compare({ label, point }) {
  const col = ZONE_COLOR(point?.zone);
  return (
    <div style={{ flex: '1 1 0', textAlign: 'center', padding: '10px 6px' }}>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
        {point ? Math.round(point.score) : '—'}
      </div>
      <div style={{ fontSize: 9, color: col.fg, letterSpacing: '0.6px' }}>{point?.zone || '—'}</div>
    </div>
  );
}

function ComponentRow({ c }) {
  const col = ZONE_COLOR(c.zone);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderTop: `1px solid ${C.border}` }}>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{c.label}</div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{c.meaning}</div>
      </div>
      {/* the score bar: position on the same 0-100 scale as the headline */}
      <div style={{ width: 120, flex: '0 0 auto' }}>
        <div style={{ height: 6, borderRadius: 999, background: C.surface2, overflow: 'hidden' }}>
          <div style={{
            width: `${c.available ? Math.min(100, Math.max(0, c.score)) : 0}%`,
            height: '100%', background: col.fg, opacity: 0.8,
          }} />
        </div>
      </div>
      <div style={{ width: 44, textAlign: 'right', fontSize: 16, fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>
        {c.available ? Math.round(c.score) : '—'}
      </div>
      <div style={{ width: 104, textAlign: 'right', fontSize: 10, fontWeight: 700, letterSpacing: '0.8px', color: col.fg }}>
        {c.available ? c.zone : 'UNAVAILABLE'}
      </div>
    </div>
  );
}

// ⚠️ NO VERSION STAMP ON THE PUBLIC PAGE. "Index version fear_greed_v1" used to be printed at
// the foot of this panel, alongside the window and component minimum. The identifier is an
// implementation detail that means nothing to a reader, and the other two numbers were already
// stated in prose above it — a line repeating them in smaller grey type reads as debug output that
// escaped, which is a strange thing to find at the bottom of a financial product. The version still
// travels in the API payload and the store, where it is load-bearing; it just is not printed here.
function Methodology({ m, components }) {
  if (!m) return null;
  return (
    <div style={{ padding: '14px 16px 18px', fontSize: 12, color: C.text, lineHeight: 1.6 }}>
      <P label="Update frequency" text={m.updateFrequency} />
      <P label="Normalisation" text={m.normalization} />
      <P label="Composite" text={m.composite} />
      <div style={{ marginTop: 14, fontFamily: "'DM Sans',sans-serif", fontSize: 10, letterSpacing: '1px', color: C.dim }}>COMPONENTS</div>
      {(components || []).map((c) => (
        <div key={c.key} style={{ marginTop: 10, paddingLeft: 10, borderLeft: `2px solid ${C.border}` }}>
          <div style={{ fontWeight: 700, color: C.ink, fontSize: 12 }}>
            {c.label}
            <span style={{ marginLeft: 8, fontWeight: 400, color: C.dim, fontSize: 11 }}>
              {c.direction === -1 ? 'higher = more fear' : 'higher = more greed'}
            </span>
          </div>
          <div style={{ color: C.muted, marginTop: 2 }}><b>Calculation.</b> {c.calculation}</div>
          <div style={{ color: C.muted }}><b>Source.</b> {c.source}</div>
        </div>
      ))}
      <div style={{ marginTop: 16, fontFamily: "'DM Sans',sans-serif", fontSize: 10, letterSpacing: '1px', color: C.dim }}>
        WHAT WE DELIBERATELY DO NOT INCLUDE
      </div>
      {(m.excluded || []).map((x) => (
        <div key={x.name} style={{ marginTop: 8, paddingLeft: 10, borderLeft: `2px solid ${C.border}` }}>
          <div style={{ fontWeight: 700, color: C.ink, fontSize: 12 }}>{x.name}</div>
          <div style={{ color: C.muted }}>{x.why}</div>
        </div>
      ))}
    </div>
  );
}
const P = ({ label, text }) => (
  <div style={{ marginTop: 8 }}>
    <span style={{ fontWeight: 700, color: C.ink }}>{label}. </span>
    <span style={{ color: C.muted }}>{text}</span>
  </div>
);

export default function FearGreedClient() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showMethod, setShowMethod] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/fear-greed', { cache: 'no-store' });
      const j = await r.json();
      setData(j); setFailed(false);
    } catch { setData(null); setFailed(true); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const zone = data?.zone?.label ?? data?.zone ?? null;

  return (
    <>
      <BrandStyles />
      <TopNav active="Fear & Greed" />
      <main style={{ maxWidth: 780, margin: '0 auto', padding: '20px 16px 60px' }}>
        {failed && <ErrorState onRetry={load} />}

        {!failed && (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
            {loading && <div style={{ padding: 48, textAlign: 'center', color: C.dim, fontSize: 13 }}>Loading…</div>}

            {!loading && data && data.available === false && (
              <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>INDEX UNAVAILABLE</div>
                {/* ⚠️ NOT A 50. An unavailable index says so; it does not render neutral. */}
                <div style={{ fontSize: 12, color: C.muted, marginTop: 6, maxWidth: 420, margin: '6px auto 0' }}>
                  {data.reason === 'insufficient-components'
                    /* ⚠️ THE THRESHOLD ITSELF IS NOT PUBLISHED. It used to interpolate
                       data.minComponents, which states the refusal rule as an integer. The reader
                       needs to know the index refused and why, not the number it refused at. */
                    ? 'Too few components could be calculated, so no score is published.'
                    : 'The index has not been calculated yet.'}
                </div>
              </div>
            )}

            {!loading && data?.available && (
              <>
                <Gauge score={data.score} zone={zone} asOf={data.asOf} />

                <div style={{ display: 'flex', borderTop: `1px solid ${C.border}`, background: C.surface }}>
                  <Compare label="PREVIOUS CLOSE" point={data.comparisons?.previousClose} />
                  <Compare label="1 WEEK AGO" point={data.comparisons?.weekAgo} />
                  <Compare label="1 MONTH AGO" point={data.comparisons?.monthAgo} />
                </div>

                <div style={{ borderTop: `1px solid ${C.border}`, padding: '10px 16px 0', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Dot /><span style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>HISTORY</span>
                </div>
                <FearGreedHistory history={data.history} />

                <div style={{ borderTop: `1px solid ${C.border}`, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 7, background: C.surface }}>
                  <Dot />
                  <span style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>WHAT IS DRIVING IT</span>
                  <span style={{ marginLeft: 'auto', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px' }}>
                    {data.componentCount}/{(data.components || []).length} COMPONENTS
                  </span>
                </div>
                {(data.components || []).map((c) => <ComponentRow key={c.key} c={c} />)}

                <div style={{ borderTop: `1px solid ${C.border}`, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.dim, letterSpacing: '0.8px' }}>
                    {data.componentCount}/{(data.components || []).length} COMPONENTS · {data.historySessions} SESSIONS
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowMethod((v) => !v)}
                    style={{
                      marginLeft: 'auto', background: 'none', border: `1px solid ${C.border2}`,
                      borderRadius: 999, padding: '4px 12px', fontSize: 11, color: C.text, cursor: 'pointer',
                    }}
                  >{showMethod ? 'Hide methodology' : 'Methodology'}</button>
                </div>
                {showMethod && (
                  <div style={{ borderTop: `1px solid ${C.border}`, background: C.surface }}>
                    <Methodology
                      m={data.methodology}
                      components={data.componentMeta}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>
      <Footer />
    </>
  );
}
