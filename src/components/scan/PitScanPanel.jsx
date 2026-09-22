'use client';
import { useEffect, useMemo, useState } from 'react';
import ScanBoardRows from './ScanBoardRows';
import { C, Badge, TickerLogo } from '../../lib/cp-shared';

// THE PIT SCAN PANEL.
//
// Two views over one engine cycle: the TABLE (what is true now) and the PULSE (what just changed).
// Both come from the same server-side calculation, so nothing here computes a velocity or a level.
//
// WHAT IT SHOWS WHEN THERE IS NO FEED — which is today — is the most important screen in the file.
// An empty table reads as "nothing is moving", which on a live market is a lie. So instead the panel
// explains what Pit Scan is, lists the signals that are built and waiting, and says precisely which
// data capability each one needs. A trader can see the product before it has a feed, and can see
// that the silence is honest rather than broken.

const fmt2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%` : '—');

const CATEGORY_TONE = {
  breakout: C.green,
  premarket: '#7A5818',
  momentum: C.green,
  relative: '#1A3A78',
  volatility: '#B4530A',
  volume: '#7B3F98',
  liquidity: C.muted,
};

export default function PitScanPanel({ onPick }) {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState('scan');
  const [preset, setPreset] = useState(null);
  const [showDark, setShowDark] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/pitscan${preset ? `?preset=${preset}` : ''}`, { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (alive) setState(j);
      } catch { if (alive) setState({ error: true, rows: [], readiness: { live: false } }); }
    };
    load();
    // Slow on purpose while there is nothing to poll for. The cadence becomes a push subscription
    // when a streaming feed exists, rather than a faster interval.
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [preset]);

  const live = state?.readiness?.live === true;

  // ⚠️ THE BOARDS MUST NOT DISAPPEAR THE MOMENT THE FEED GOES LIVE, AND THEY WOULD HAVE.
  //
  // This panel branched on `live` alone: false → the three evidence boards, true → ScanTable over
  // state.rows. But scanState() returns rows: [] because no intraday INGESTION is wired — the
  // runtime's own comment says so. So switching the provider descriptor to realtime, which is
  // exactly what the commercial entitlement does, would have swapped a working product for an
  // empty table. Live prices arriving is not the same event as an ingestion worker existing.
  //
  // So the legacy signal tables render only when they genuinely have something, and the boards —
  // which are the product — render the rest of the time. Neither path changed; only the question
  // being asked to choose between them.
  // ⚠️ AND IT IS NOT ENOUGH TO ASK WHETHER `rows` IS EMPTY — THIS TOOK THE TERMINAL DOWN.
  //
  // I guarded on `rows.length > 0` assuming the array would stay empty until an ingestion worker
  // existed. It did not. With TIINGO_REALTIME_ENABLED=true the scan runtime reports live, and
  // /api/pitscan began returning four rows — but they are BOARD rows (ticker, last, structure,
  // evidence, join, facts), not SIGNAL-engine rows (symbol, price, velocity, signals, context).
  // Two different shapes behind one field name. ScanTable then ran `r.signals.map(...)` on rows
  // that have no `signals`, threw a TypeError during render, and — with no error boundary
  // anywhere — unmounted the entire Terminal, not just this panel.
  //
  // So the question is the SHAPE, not the count. A row belongs to the signal table only if it
  // carries the fields that table reads.
  const signalRows = (state?.rows || []).filter((r) => r && r.symbol && Array.isArray(r.signals));
  const hasSignalRows = live && (signalRows.length > 0 || (state?.events?.length || 0) > 0);
  const byCategory = useMemo(() => {
    const out = new Map();
    for (const s of state?.signals?.disabled || []) {
      if (!out.has(s.category)) out.set(s.category, []);
      out.get(s.category).push(s);
    }
    return out;
  }, [state]);

  const tabBtn = (id, label) => (
    <button key={id} onClick={() => setTab(id)}
      style={{
        fontSize: 10.5, fontWeight: 700, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
        border: 'none', background: tab === id ? C.selBg : 'transparent', color: tab === id ? C.selFg : C.muted,
      }}>{label}</button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
        borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        {tabBtn('scan', 'Scan')}
        {tabBtn('pulse', 'Pit Pulse')}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
          {/* THE FEED STATE IS ALWAYS VISIBLE. A scanner that does not say how fresh it is invites
              the reader to assume the best.

              ⚠️ NEVER "LIVE", AND NO LONGER "AWAITING FEED". Realtime is not entitled, so LIVE
              would be a false claim about every number below it. "AWAITING FEED" was equally
              wrong in the other direction — it described the unfed SIGNAL engine while the
              evidence boards were full — and read as a broken product. What is printed is the
              freshness the rows actually carry. */}
          <Badge dot>{state?.freshnessLabel || 'LAST CLOSE'}</Badge>
        </span>
      </div>

      {!state ? (
        <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12.5 }}>Loading Pit Scan…</div>
      ) : !hasSignalRows ? (
        <div style={{ overflow: 'auto', flex: 1, padding: '16px 14px' }}>
          {/* ── THE EVIDENCE BOARDS RUN TODAY ───────────────────────────────────────
              The signal engine still waits for a realtime feed — that part of the panel below is
              unchanged and still true. But the three boards are driven by the Consensus evidence
              payload plus whatever quote we are entitled to, and two of them are fully honest on
              end-of-day data: one is timestamped from public filings, the other only needs the sign
              of a move. Every row states the freshness of its own price, so nothing here claims to
              be a live tape. */}
          {/* ⚠️ DETAIL IS PRESERVED BY SCROLLING, NEVER BY DROPPING FIELDS. A Terminal panel can be
              dragged down to MIN_W (240px), which is narrower than these cards read well at. The
              answer is a floor plus a horizontal scrollbar: every field — structure, evidence,
              JOIN, the facts, the freshness chip and all four actions — stays on the card at any
              panel width, and the user scrolls to reach it. Hiding columns to fit would be the one
              thing this panel must not do, because the fields it would drop are the reasons the
              row is on the board at all.

              `onPick` is the Terminal's existing ticker link, threaded to the SAME card the /scan
              page renders. On /scan no onPick is passed and the symbol stays a plain link. */}
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 300 }}>
              <ScanBoardRows onPick={onPick} />
            </div>
          </div>

          <div style={{ height: 1, background: C.border, margin: '18px 0 14px' }} />

          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 5 }}>
            {live ? 'Intraday signals are not running yet' : 'Intraday signals are still waiting on market data'}
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.6, marginBottom: 14 }}>
            {/* ⚠️ TWO DIFFERENT REASONS, AND THEY MUST NOT BORROW EACH OTHER'S WORDS. Before the
                entitlement the feed was the blocker. With realtime on, prices ARE live and the
                blocker is that no intraday ingestion worker exists — saying "waiting on market
                data" then would blame a provider that is now delivering. */}
            {live
              ? 'Live prices are connected. The intraday signal engine needs an ingestion worker, which is not running yet — so the signals below stay dark rather than showing a half-filled table.'
              : (state.readiness?.reason
                || 'Pit Scan goes live when the market-data provider is connected.')}
            {' '}The intraday signals below will not run on delayed prints: a fifteen-minute-old
            answer to “what is moving right now” is not a worse answer, it is a misleading one. The
            evidence boards above do run, because they are timestamped from public filings and label
            the freshness of every price they show.
          </div>

          {/* The signals that exist, grouped by what each is waiting for. This is the product, and a
              trader can read it today. */}
          <div style={{ fontSize: 9, color: C.dim, letterSpacing: 0.6, marginBottom: 6 }}>
            SIGNALS BUILT · {(state.signals?.enabled?.length || 0) + (state.signals?.disabled?.length || 0)}
          </div>
          {[...byCategory.entries()].map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: CATEGORY_TONE[cat] || C.ink, marginBottom: 3 }}>
                {cat.toUpperCase()}
              </div>
              {list.slice(0, showDark ? list.length : 4).map((s) => (
                <div key={s.id} style={{ display: 'flex', gap: 8, fontSize: 11, color: C.text, padding: '1px 0' }}>
                  <span style={{ flex: 1 }}>{s.label}</span>
                  <span style={{ color: C.dim, fontSize: 10 }}>{s.reason}</span>
                </div>
              ))}
              {!showDark && list.length > 4 && (
                <div style={{ fontSize: 10, color: C.dim }}>+{list.length - 4} more</div>
              )}
            </div>
          ))}
          {(state.signals?.disabled?.length || 0) > 4 && (
            <button onClick={() => setShowDark((v) => !v)}
              style={{ background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 4,
                cursor: 'pointer', padding: '3px 10px', fontSize: 10.5, color: C.muted }}>
              {showDark ? 'Show less' : 'Show every signal'}
            </button>
          )}
        </div>
      ) : tab === 'scan' ? (
        <ScanTable rows={signalRows} onPick={onPick} />
      ) : (
        <PulseTape events={state.events} onPick={onPick} />
      )}
    </div>
  );
}

/** The dense table. One row per symbol with something true about it, newest signal first. */
function ScanTable({ rows, onPick }) {
  if (!rows?.length) {
    return <div style={{ padding: '20px 16px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>
      Nothing is crossing a Pit Scan threshold right now.
    </div>;
  }
  return (
    <div style={{ overflow: 'auto', flex: 1 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr style={{ background: C.surface }}>
          {['', 'Price', 'Chg', '5m', 'Signals'].map((h, i) => (
            <th key={i} style={{ padding: '5px 8px', textAlign: i === 0 || i === 4 ? 'left' : 'right',
              fontSize: 8.5, color: C.dim, letterSpacing: '0.5px', position: 'sticky', top: 0,
              background: C.surface }}>{h.toUpperCase()}</th>
          ))}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.symbol} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
              <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                <span onClick={() => onPick && onPick(r.symbol)} title="Load in chart"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <TickerLogo symbol={r.symbol} size={15} />
                  <span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{r.symbol}</span>
                </span>
              </td>
              <td className="cp-num" style={{ padding: '6px 8px', textAlign: 'right', color: C.ink }}>{fmt2(r.price)}</td>
              <td className="cp-num" style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600,
                color: r.changePct == null ? C.dim : r.changePct >= 0 ? C.green : C.red }}>{pct(r.changePct)}</td>
              <td className="cp-num" style={{ padding: '6px 8px', textAlign: 'right', color: C.text }}>
                {pct(r.velocity?.['5m']?.pct)}
              </td>
              {/* THE COLUMN THE PRODUCT IS ABOUT: what is true, not a score. */}
              <td style={{ padding: '5px 8px' }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {/* ⚠️ OPTIONAL, BECAUSE THIS EXACT LINE TOOK PRODUCTION DOWN. It read
                      `r.signals.map(...)`, which is correct for every row this table was designed
                      for and a TypeError for any row that is not one. A rendering component must
                      not be the thing that decides a payload is malformed — it should draw what it
                      can and leave the row selection to the caller. The caller now filters by
                      shape; this is the belt to that pair of braces. */}
                  {(r.signals || []).map((s) => (
                    <span key={s.id} title={s.detail}
                      style={{ fontSize: 8.5, fontWeight: 700, padding: '2px 5px', borderRadius: 3,
                        color: '#fff', background: CATEGORY_TONE[s.category] || C.ink }}>
                      {s.label.toUpperCase()}
                    </span>
                  ))}
                  {r.context?.badge && (
                    <span style={{ fontSize: 8.5, fontWeight: 700, padding: '2px 5px', borderRadius: 3,
                      color: C.ink, border: `1px solid ${C.border}` }}>{r.context.badge.label}</span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The live tape: what JUST happened, newest first. */
function PulseTape({ events, onPick }) {
  if (!events?.length) {
    return <div style={{ padding: '20px 16px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>
      Nothing has crossed yet.
    </div>;
  }
  return (
    <div style={{ overflow: 'auto', flex: 1, fontFamily: 'ui-monospace, monospace' }}>
      {events.map((e) => (
        <div key={e.id} style={{ display: 'flex', gap: 8, padding: '3px 10px', fontSize: 11,
          borderBottom: `1px solid ${C.surface}` }}>
          <span style={{ color: C.dim }}>{e.time}</span>
          <span onClick={() => onPick && onPick(e.symbol)} className="cp-tkr"
            style={{ color: C.ink, fontWeight: 700, cursor: 'pointer', minWidth: 52 }}>{e.symbol}</span>
          <span style={{ color: CATEGORY_TONE[e.category] || C.text, fontWeight: 600 }}>{e.label}</span>
        </div>
      ))}
    </div>
  );
}
