'use client';

// MARKET STRUCTURE — the ticker page's price-structure card.
//
// THE PRICE ZONES ARE THE PRODUCT. Every level is shown as the actual calculated range with its
// distance, never as "near support". Nothing here recomputes a level, rounds one in a way that
// changes its meaning, or relabels a timeframe: the component renders canonical engine output and
// the server decided which parts of it this user receives.
//
// ── MARKET STRUCTURE IS NOT A CHART INDICATOR ───────────────────────────────
//
// The product line is deliberate and worth stating where someone will read it:
//
//   CHART              price and candles, the user's own indicators, and Evidence event markers —
//                      things that happened at a point in time (Form 4, 13F, Congress, 8-K, and
//                      later earnings), controlled by the Evidence menu.
//   MARKET STRUCTURE   Catalyst Pit's ANALYSIS of that chart: confirmed swing structure,
//                      resistance, multi-timeframe confluence. It lives HERE.
//
// So these zones are never drawn across the chart, and there is no Levels toolbar control, no
// Market Structure indicator and no entry in the Indicators or Evidence menus. A zone is quoted as
// a RANGE ($481–$485) because support is an area rather than false penny-level precision — that is
// a statement about the number's honesty, not a request for a visual band. The chart stays clean.
//
// ── THE STRICT LABEL STANDS ─────────────────────────────────────────────────
//
// The rejected "bullish transition / current condition" state is deliberately absent. Where the
// strict swing label may read oddly against the chart — a monthly lower-highs-and-lows reading after
// a large advance — the card shows the STRUCTURAL FACTS that explain the gap: how far price has come
// since the pivot the structure was confirmed on, and whether the last confirmed swing high has been
// reclaimed. A reader can then disagree with the label on evidence rather than being quietly told
// something softer.
//
// ── MOBILE ──────────────────────────────────────────────────────────────────
//
// No table, no fixed columns, no horizontal scroll. The three timeframes are a CSS grid that
// collapses to one column, and every zone is its own block whose price range is the largest thing
// in it — the number a phone user came for should never be the thing that gets truncated.

import { useEffect, useState } from 'react';
import { C, Dot, Skel, startCheckout } from '../lib/cp-shared';

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const pctText = (n) => (n == null ? '' : `${Number(n).toFixed(2)}%`);

// ── THE LABEL DESCRIBES CONFIRMED STRUCTURE, NOT A CURRENT TREND ────────────
//
// Measured over 762 daily / 726 weekly tickers and 112,620 point-in-time samples
// (research/trend-methodology-report.md): at label time the TRAILING window is strongly
// directional — +6.12% median for the up state, 78.6% matching sign — while across the span the
// label is actually displayed it is a coin flip (46.7%, and the median carries the wrong sign).
//
// So the engine truthfully identifies a higher-high/higher-low SEQUENCE that has already formed.
// The word "Uptrend" asserted something stronger: that it is still happening. These words say what
// was actually computed. Sweeping pivotWidth 2-6 confirmed this is structural, not a tuning
// problem — no width made the present-tense reading true, so the wording changed instead.
//
// The classifier is untouched: same states, same colours, same underlying field.
const TREND_LABEL = {
  uptrend: 'Higher highs & lows',
  downtrend: 'Lower highs & lows',
  range: 'No clear sequence',
  'insufficient-history': 'Insufficient history',
};
const trendColor = (t) => (t === 'uptrend' ? C.green : t === 'downtrend' ? C.red : C.muted);

const ALIGNMENT_LABEL = {
  'bullish-alignment': 'Bullish alignment',
  'bearish-alignment': 'Bearish alignment',
  'long-term-bullish-short-term-weak': 'Long-term bullish, short-term weak',
  'long-term-bearish-short-term-strong': 'Long-term bearish, short-term strong',
  'structure-conflict': 'Structure conflict',
  mixed: 'Mixed',
  'insufficient-history': 'Insufficient history',
};

// ── a price zone ─────────────────────────────────────────────────────────────

function Zone({ title, zone, side, relationship, expandable = true }) {
  const [open, setOpen] = useState(false);
  if (!zone) {
    // A level the engine did not find is ABSENT, not invented. Section 10.
    return (
      <div style={{ padding: '9px 0' }}>
        <div style={lblStyle}>{title}</div>
        <div style={{ fontSize: 12, color: C.muted, fontWeight: 300, marginTop: 2 }}>
          None identified
        </div>
      </div>
    );
  }
  const col = side === 'support' ? C.green : C.red;
  const dirWord = side === 'support' ? 'below' : 'above';

  return (
    <div style={{ padding: '9px 0', borderTop: `1px solid ${C.surface}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={lblStyle}>{title}</span>
        {zone.major && (
          <span style={{
            fontSize: 8.5, letterSpacing: '0.6px', fontFamily: "'DM Sans',sans-serif",
            background: '#FFF6E8', color: '#7A5018', padding: '1px 5px', borderRadius: 3, fontWeight: 600,
          }}>MAJOR</span>
        )}
        {zone.multiTimeframe && (
          <span style={{
            fontSize: 8.5, letterSpacing: '0.6px', fontFamily: "'DM Sans',sans-serif",
            background: C.blueLight, color: C.blue, padding: '1px 5px', borderRadius: 3, fontWeight: 600,
          }}>MULTI-TIMEFRAME</span>
        )}
      </div>

      {/* THE RANGE IS THE HEADLINE. Wrapped rather than truncated — a clipped price is useless. */}
      <div className="cp-num" style={{
        fontSize: 17, fontWeight: 600, color: C.ink, marginTop: 3, lineHeight: 1.25,
        overflowWrap: 'anywhere',
      }}>
        {money(zone.low)} – {money(zone.high)}
      </div>

      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
        <span className="cp-num" style={{ color: col, fontWeight: 600 }}>{pctText(zone.distancePct)}</span>
        {` ${dirWord} price`}
        {zone.timeframes?.length ? ` · ${zone.timeframes.map(tfWord).join(' + ')}` : ''}
      </div>

      {relationship && (
        <div style={{ fontSize: 11, color: C.dim, marginTop: 2, fontWeight: 300 }}>
          {relationship.detail}
        </div>
      )}

      {/* EXPLAINABILITY. Collapsed by default so the compact view stays readable; every line is a
          component level the engine returned, never a generated sentence. */}
      {expandable && zone.reasons?.length > 0 && (
        <>
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{
              background: 'transparent', border: 'none', padding: '4px 0 0', cursor: 'pointer',
              color: C.green, fontSize: 11, fontFamily: "'DM Sans',sans-serif",
            }}>
            {open ? 'Hide why' : 'Why this level'} {open ? '▴' : '▾'}
          </button>
          {open && (
            <ul style={{ margin: '4px 0 0', padding: '0 0 0 14px', listStyle: 'disc' }}>
              {zone.reasons.map((r, i) => (
                <li key={i} style={{ fontSize: 11.5, color: C.text, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{r}</li>
              ))}
              {zone.reasonsTruncated && (
                <li style={{ fontSize: 11, color: C.muted, fontWeight: 300 }}>
                  More component levels with Pit Pro
                </li>
              )}
              {zone.majorCriteria?.map((c, i) => (
                <li key={`c${i}`} style={{ fontSize: 11.5, color: '#7A5018', lineHeight: 1.5 }}>{c}</li>
              ))}
              {Number.isFinite(zone.touches) && zone.touches > 0 && (
                <li style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>
                  {zone.touches} historical reaction{zone.touches === 1 ? '' : 's'} at this level
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

const lblStyle = {
  fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim,
  letterSpacing: '0.6px', textTransform: 'uppercase',
};
const tfWord = (t) => ({ daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[t] || t);

// ── one timeframe ────────────────────────────────────────────────────────────

function Timeframe({ tf }) {
  if (!tf) return null;
  if (!tf.available) {
    return (
      <div style={tfBox}>
        <div style={lblStyle}>{tf.label}</div>
        <div style={{ fontSize: 12, color: C.muted, fontWeight: 300, marginTop: 4, lineHeight: 1.45 }}>
          Insufficient history
        </div>
        <div style={{ fontSize: 10.5, color: C.dim, fontWeight: 300, marginTop: 2 }}>{tf.reason}</div>
      </div>
    );
  }
  const d = tf.structuralDisruption;
  return (
    <div style={tfBox}>
      <div style={lblStyle}>{tf.label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: trendColor(tf.trend), marginTop: 2 }}>
        {TREND_LABEL[tf.trend] || tf.trend}
      </div>
      {tf.trendReasons?.slice(0, 2).map((r, i) => (
        <div key={i} style={{ fontSize: 11, color: C.muted, fontWeight: 300, marginTop: 1, overflowWrap: 'anywhere' }}>{r}</div>
      ))}

      {/* STRUCTURAL FACTS, not a softer label. This is what lets a reader see why a strict label can
          differ from their visual read of the chart. */}
      {(Number.isFinite(tf.priceSincePivotPct) || d?.note) && (
        <div style={{ marginTop: 5, paddingTop: 5, borderTop: `1px solid ${C.surface}` }}>
          {Number.isFinite(tf.priceSincePivotPct) && (
            <div style={{ fontSize: 11, color: C.text, lineHeight: 1.45 }}>
              <span className="cp-num" style={{ fontWeight: 600, color: tf.priceSincePivotPct >= 0 ? C.green : C.red }}>
                {tf.priceSincePivotPct >= 0 ? '+' : ''}{pctText(tf.priceSincePivotPct)}
              </span>
              {` since the ${tf.trendAsOfPivot} pivot this structure was confirmed on`}
            </div>
          )}
          {d?.note && (
            <div style={{ fontSize: 11, color: C.text, lineHeight: 1.45, marginTop: 1, overflowWrap: 'anywhere' }}>{d.note}</div>
          )}
        </div>
      )}

      <div style={{ marginTop: 4 }}>
        <Zone title="Nearest support" zone={tf.support?.nearest} side="support" />
        <Zone title="Nearest resistance" zone={tf.resistance?.nearest} side="resistance" />
      </div>
    </div>
  );
}

const tfBox = { minWidth: 0, padding: '10px 12px', background: C.surface, borderRadius: 8 };

// ── the upgrade treatment ────────────────────────────────────────────────────

function ProTeaser({ locked, symbol }) {
  // Names only what the engine actually found for THIS ticker. Selling weekly structure on a
  // security that does not have enough history for it would be selling nothing.
  const bits = [];
  if (locked?.weekly) bits.push('Weekly structure');
  if (locked?.monthly) bits.push('Monthly structure');
  if (locked?.majorSupport || locked?.majorResistance) bits.push('Major levels');
  const conf = (locked?.confluenceSupportCount || 0) + (locked?.confluenceResistanceCount || 0);
  if (conf > 0) bits.push(`${conf} multi-timeframe confluence zone${conf === 1 ? '' : 's'}`);
  if (locked?.alignment) bits.push('Timeframe alignment');
  if (!bits.length) return null;

  return (
    <div style={{
      marginTop: 12, padding: '12px 14px', borderRadius: 8,
      background: C.greenLight, border: `1px solid ${C.greenBorder}`,
    }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, lineHeight: 1.45 }}>
        {bits.join(' · ')}
      </div>
      <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 300, marginTop: 3, lineHeight: 1.5 }}>
        Unlock the full multi-timeframe structure for {symbol} with Pit Pro.
      </div>
      <button
        onClick={() => startCheckout()}
        style={{
          marginTop: 8, background: C.green, color: '#fff', border: 'none', borderRadius: 6,
          padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
          fontFamily: "'DM Sans',sans-serif", minHeight: 36,
        }}>
        Upgrade to Pit Pro
      </button>
    </div>
  );
}

// ── the card ─────────────────────────────────────────────────────────────────

export default function MarketStructure({ symbol }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    setState({ loading: true, error: null, data: null });
    fetch(`/api/structure?ticker=${encodeURIComponent(symbol)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (alive) setState({ loading: false, error: null, data: d }); })
      // A failed fetch is an ERROR state, distinct from "no structure" — rendering an outage as
      // "insufficient history" would be a quiet lie about the security.
      .catch((e) => { if (alive) setState({ loading: false, error: String(e.message || e), data: null }); });
    return () => { alive = false; };
  }, [symbol]);

  const { loading, error, data } = state;
  const pro = data?.tier === 'pro' || data?.tier === 'elite';

  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Market structure</span>
        {data?.available && (
          <span className="cp-num" style={{ fontSize: 11, color: C.muted, marginLeft: 'auto' }}>
            {money(data.currentPrice)} · {data.priceDate}
          </span>
        )}
      </div>

      <div style={{ padding: 14 }}>
        {loading && Array(4).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}

        {!loading && error && (
          <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
            Market structure is temporarily unavailable.
          </div>
        )}

        {/* Insufficient history and a suppressed price series are PRODUCT STATES with their own
            reason, never a blank card and never a guess. */}
        {!loading && !error && data && !data.available && (
          <div style={{ padding: '14px 4px', textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: C.ink, fontWeight: 500 }}>Structure unavailable</div>
            <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 300, marginTop: 3 }}>{data.reason}</div>
          </div>
        )}

        {!loading && !error && data?.available && (
          <>
            {/* Timeframes. Free receives daily only; the grid collapses to one column on a phone. */}
            <div className="ms-tf-grid">
              <Timeframe tf={data.daily} />
              {pro && <Timeframe tf={data.weekly} />}
              {pro && <Timeframe tf={data.monthly} />}
            </div>

            {pro && data.alignment?.state && (
              <div style={{ marginTop: 12, padding: '10px 12px', background: C.surface, borderRadius: 8 }}>
                <div style={lblStyle}>Timeframe alignment</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginTop: 2 }}>
                  {ALIGNMENT_LABEL[data.alignment.state] || data.alignment.state}
                </div>
                {data.conflicts?.map((c, i) => (
                  <div key={i} style={{ fontSize: 11, color: C.muted, fontWeight: 300, marginTop: 1, overflowWrap: 'anywhere' }}>{c}</div>
                ))}
              </div>
            )}

            {/* The overall actionable levels. Free gets nearest; Pro also gets major. */}
            <div style={{ marginTop: 12 }}>
              <div style={{ ...lblStyle, marginBottom: 2 }}>Key levels</div>
              <Zone title="Nearest support" zone={data.nearestSupport} side="support"
                relationship={data.supportRelationship} />
              {pro && !data.majorSupportIsNearest && (
                <Zone title="Major support" zone={data.majorSupport} side="support" />
              )}
              {pro && data.majorSupportIsNearest && (
                <div style={{ fontSize: 11, color: C.muted, fontWeight: 300, padding: '2px 0 8px' }}>
                  Major support is the same zone as nearest.
                </div>
              )}
              <Zone title="Nearest resistance" zone={data.nearestResistance} side="resistance"
                relationship={data.resistanceRelationship} />
              {pro && !data.majorResistanceIsNearest && (
                <Zone title="Major resistance" zone={data.majorResistance} side="resistance" />
              )}
              {pro && data.majorResistanceIsNearest && (
                <div style={{ fontSize: 11, color: C.muted, fontWeight: 300, padding: '2px 0' }}>
                  Major resistance is the same zone as nearest.
                </div>
              )}
            </div>

            {!pro && <ProTeaser locked={data.locked} symbol={symbol} />}

            <div style={{ marginTop: 12, fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
              Structure is read from confirmed swing pivots on completed bars. A pivot is only counted
              once the bars after it have printed, so the label can lag a sharp move — the figures
              above each timeframe show by how much. Levels are zones, not single prices.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
