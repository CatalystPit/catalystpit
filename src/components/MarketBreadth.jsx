'use client';
import { useState, useEffect } from 'react';
import { C } from '../lib/cp-shared';

// MARKET BREADTH — four compact cards under the homepage index charts.
//
// ⚠️ EVERY CARD CARRIES ITS OWN DENOMINATOR. A stock listed three weeks ago has a previous close and no
// 200-day average, so the four cards measure four different populations: ~5,334 for advance/decline,
// ~4,505 for 52-week extremes, ~4,949 for SMA50, ~4,504 for SMA200. The API returns each one and the
// footer prints it, because a percentage without its denominator invites the reader to assume the
// market-wide count.
//
// ⚠️ AND MISSING DATA IS NEVER DRAWN AS ZERO. No snapshot renders "unavailable"; a snapshot that has
// missed a rebuild renders its session date with a stale marker. A bar is drawn only when there is
// something behind it — a zero-width green bar beside a zero-width red one reads as "the market was
// perfectly balanced", which is the opposite of "we do not know".

const pct = (v) => (v == null ? null : `${v.toFixed(1)}%`);
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));

/**
 * One proportional bar. `share` is the green share of the whole bar, 0-100, or null to draw nothing.
 */
function Bar({ share }) {
  const known = share != null && Number.isFinite(share);
  return (
    <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', background: C.border, marginTop: 6 }}>
      {known ? (
        <>
          <div style={{ width: `${Math.max(0, Math.min(100, share))}%`, background: C.green }} />
          <div style={{ flex: 1, background: C.red }} />
        </>
      ) : null}
    </div>
  );
}

/**
 * A card with a left (positive) and right (negative) figure.
 *
 * `barShare` is separated from the displayed percentages on purpose — see the 52-week card, where the
 * two are deliberately different quantities.
 */
function Card({ title, leftLabel, rightLabel, leftPct, leftCount, rightPct, rightCount, barShare, note }) {
  return (
    <div style={{ background: C.white, padding: '9px 11px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 9.5, fontWeight: 700, color: C.green, letterSpacing: '0.3px', whiteSpace: 'nowrap' }}>{leftLabel}</span>
        {title ? (
          <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.7px', whiteSpace: 'nowrap' }}>{title}</span>
        ) : null}
        <span style={{ fontSize: 9.5, fontWeight: 700, color: C.red, letterSpacing: '0.3px', whiteSpace: 'nowrap' }}>{rightLabel}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: 3 }}>
        <span className="cp-num" style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, whiteSpace: 'nowrap' }}>
          {pct(leftPct) ?? '—'}
          <span style={{ fontSize: 10.5, fontWeight: 500, color: C.muted, marginLeft: 4 }}>({num(leftCount)})</span>
        </span>
        <span className="cp-num" style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 10.5, fontWeight: 500, color: C.muted, marginRight: 4 }}>({num(rightCount)})</span>
          {pct(rightPct) ?? '—'}
        </span>
      </div>
      <Bar share={barShare} />
      {note ? (
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 8.5, color: C.dim, marginTop: 4, letterSpacing: '0.2px' }}>{note}</div>
      ) : null}
    </div>
  );
}

export default function MarketBreadth() {
  const [state, setState] = useState({ loading: true, breadth: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/market-breadth');
        const j = r.ok ? await r.json() : null;
        if (alive) setState({ loading: false, breadth: j?.breadth ?? null });
      } catch { if (alive) setState({ loading: false, breadth: null }); }
    })();
    return () => { alive = false; };
  }, []);

  const b = state.breadth;
  const shell = (children) => (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', marginTop: 14 }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>MARKET BREADTH</span>
        <span style={{ marginLeft: 'auto', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px' }}>
          {/* ⚠️ THE SESSION IT DESCRIBES, NOT "LIVE". The inputs are completed daily sessions. */}
          {b ? `${b.stale ? 'STALE · ' : ''}CLOSE ${b.asOfSession}` : 'DAILY'}
        </span>
      </div>
      {children}
    </div>
  );

  if (state.loading) {
    return shell(
      <div style={{ padding: '18px 16px', fontSize: 12, color: C.muted }}>Loading breadth…</div>,
    );
  }
  if (!b) {
    // ⚠️ SAID PLAINLY. Not four cards of zeros.
    return shell(
      <div style={{ padding: '18px 16px', fontSize: 12, color: C.muted }}>
        Breadth is unavailable right now.
      </div>,
    );
  }

  const { advancing: a, highsLows: hl, sma50: s50, sma200: s200 } = b;
  return shell(
    <>
      {/* ⚠️ auto-fit AGAINST THE CONTAINER, NOT A VIEWPORT MEDIA QUERY. This card sits in the
          homepage's main column beside a 300px rail, so its width is not the window's width — and a
          `max-width: 1100px` query would still hand four columns to a 410px box, squeezing every
          figure. auto-fit with a 150px floor gives four across when the column is wide, two when it is
          not, and one on a phone, deciding from the space actually available. minmax(0, …) is what
          keeps a long count from forcing horizontal overflow. */}
      <div className="cp-breadth-grid"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 1, background: C.border }}>
        <Card
          leftLabel="ADVANCING" rightLabel="DECLINING"
          leftPct={a.upPct} leftCount={a.up} rightPct={a.downPct} rightCount={a.down}
          // Advancing as a share of advancing + declining, so the bar is the up/down split rather than
          // a pair of slivers against the unchanged remainder.
          barShare={a.up + a.down > 0 ? (a.up / (a.up + a.down)) * 100 : null}
          note={`${num(a.eligible)} stocks${a.flat ? ` · ${num(a.flat)} unchanged` : ''}`}
        />
        <Card
          title="52 WEEK" leftLabel="NEW HIGH" rightLabel="NEW LOW"
          leftPct={hl.upPct} leftCount={hl.up} rightPct={hl.downPct} rightCount={hl.down}
          // ⚠️ THE BAR IS THE HIGH/LOW SPLIT OF THE STOCKS AT AN EXTREME, and the note says so. The
          // percentages beside it are of the whole eligible universe, which is the honest reading —
          // most stocks are at neither extreme, so the two quantities are not interchangeable and a bar
          // drawn from the percentages would be two slivers with no meaning.
          barShare={hl.split.highShare}
          note={hl.split.total > 0
            ? `${num(hl.eligible)} stocks · bar = ${num(hl.split.total)} at an extreme`
            : `${num(hl.eligible)} stocks · none at an extreme`}
        />
        <Card
          title="SMA 50" leftLabel="ABOVE" rightLabel="BELOW"
          leftPct={s50.upPct} leftCount={s50.up} rightPct={s50.downPct} rightCount={s50.down}
          barShare={s50.up + s50.down > 0 ? (s50.up / (s50.up + s50.down)) * 100 : null}
          note={`${num(s50.eligible)} with 50+ sessions`}
        />
        <Card
          title="SMA 200" leftLabel="ABOVE" rightLabel="BELOW"
          leftPct={s200.upPct} leftCount={s200.up} rightPct={s200.downPct} rightCount={s200.down}
          barShare={s200.up + s200.down > 0 ? (s200.up / (s200.up + s200.down)) * 100 : null}
          note={`${num(s200.eligible)} with 200+ sessions`}
        />
      </div>
      <div style={{ padding: '6px 11px', borderTop: `1px solid ${C.border}`, fontFamily: "'DM Sans',sans-serif", fontSize: 8.5, color: C.dim }}>
        U.S. common stocks on NYSE, NASDAQ and NYSE American · closing basis · each metric uses only the
        stocks with the history it needs
      </div>
    </>,
  );
}
