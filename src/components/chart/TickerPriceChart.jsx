'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { C, Dot } from '../../lib/cp-shared';
import CPChart from './CPChart';
import { timeframe, DEFAULT_TIMEFRAME } from '../../lib/chart/chart-source.mjs';

// The ticker page's price chart: the Catalyst Pit card shell around CPChart, plus the Evidence
// Timeline's data.
//
// Replaces the licensed TradingView Advanced Chart widget for US EQUITIES ONLY. The futures blocks
// further down that page still use the widget, deliberately: they address TradingView symbols
// ("CME_MINI:ES1!") and our licensed data is Tiingo daily plus Polygon equity aggregates, which
// covers neither futures continuations nor their symbology. Swapping those would produce an empty
// chart, so they are left alone until a futures source exists.
//
// ── WHY THE HOST FETCHES, NOT THE CHART ─────────────────────────────────────
//
// CPChart is a renderer and is used by the Terminal too. Putting the query here keeps the chart
// free of data concerns, and means the Evidence Timeline and What Changed are two consumers of one
// API rather than two places that know how to ask.

// Evidence is fetched for a fixed span rather than the live viewport. See the note in the effect.
//
// ⚠️ IT MUST COVER THE CHART, AND FOR A WHILE IT DID NOT. This was a hardcoded two years while the
// default daily chart loads 1,825 days of candles — so years three to five of the chart everyone
// opens on had no markers at all, and the comment below claimed the window "covers every timeframe
// the page opens on". It did not. A user scrolling back through a perfectly ordinary daily chart
// saw filings simply stop.
//
// Derived from the timeframe definition rather than restated, so the two cannot drift apart again.
// Measured on GOLD before widening: 730d → 33 markers / 35.3KB, 1825d → 34 markers / 36.6KB, and
// 3650d → still 34 / 36.6KB, because the engine's own history bound caps what it will return. So
// this costs +1.2KB (+3.5%) for one request per symbol, and reaching past it buys nothing.
const EVIDENCE_WINDOW_DAYS = timeframe(DEFAULT_TIMEFRAME)?.window?.days ?? 365 * 2;

export default function TickerPriceChart({ symbol }) {
  const router = useRouter();
  const [evidence, setEvidence] = useState(null);
  // Guards against the out-of-order response: a fast request for the NEW symbol can land before a
  // slow one for the old, and applying the loser would put the previous ticker's filings on this
  // ticker's candles.
  const reqRef = useRef(0);

  useEffect(() => {
    if (!symbol) { setEvidence(null); return; }
    const id = ++reqRef.current;
    // Cleared IMMEDIATELY on a symbol change, before the request goes out. The chart treats this as
    // "no evidence" and wipes its markers, so the old ticker's markers can never be visible over
    // the new ticker's price, even for the duration of one fetch.
    setEvidence(null);

    const ctrl = new AbortController();
    const to = new Date();
    const from = new Date(to.getTime() - EVIDENCE_WINDOW_DAYS * 86400000);

    // ONE REQUEST PER SYMBOL, NOT ONE PER PAN. The chart's visible range changes on every scroll
    // and every timeframe click; refetching on those would be a request storm for data that is
    // already in memory. The window matches the daily chart's own span (see EVIDENCE_WINDOW_DAYS),
    // and markers outside the visible bars are simply not placed — snapToBar returns null.
    //
    // The weekly and monthly timeframes request 'all' history and so can still show candles older
    // than this window. That is a real bound, and it is the right one: measured, the engine
    // returns nothing beyond roughly four years for these families, so fetching further back buys
    // an empty response rather than more markers.
    fetch(`/api/evidence?ticker=${encodeURIComponent(symbol)}`
      + `&from=${from.toISOString()}&to=${to.toISOString()}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (ctrl.signal.aborted || id !== reqRef.current) return;
        setEvidence(Array.isArray(d?.evidence) ? d.evidence : []);
      })
      // The timeline is an enhancement. If it fails the chart must still be a chart — so this
      // resolves to "no evidence" rather than surfacing an error over the price.
      .catch(() => { if (id === reqRef.current) setEvidence([]); });

    return () => ctrl.abort();
  }, [symbol]);

  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Price chart</span>
        {evidence?.length > 0 && (
          <span style={{ fontSize: 10, color: C.muted, marginLeft: 'auto' }}>
            {evidence.length} evidence marker{evidence.length === 1 ? '' : 's'} · click to inspect
          </span>
        )}
      </div>
      {/* A real height: the chart autosizes to its host, and a host with no height renders nothing. */}
      <div style={{ padding: 14, height: 'clamp(460px, 62vh, 700px)', display: 'flex', flexDirection: 'column' }}>
        {/* HERE the page owns the symbol, so picking one in the chart navigates to that ticker's
            page rather than leaving this chart on a symbol the rest of the page is not about. In a
            Terminal panel the chart owns it instead and nothing navigates — see CPChart. */}
        {/* One candle per trading day, five years of them — the same default every chart opens on. */}
        <CPChart symbol={symbol} initialTimeframe="1D" transparent evidence={evidence}
          onSymbolPick={(s) => router.push(`/ticker/${encodeURIComponent(s)}`)} />
      </div>
    </div>
  );
}
