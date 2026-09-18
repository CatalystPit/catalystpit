'use client';
import { useRouter } from 'next/navigation';
import { C, Dot } from '../../lib/cp-shared';
import CPChart from './CPChart';

// The ticker page's price chart: the Catalyst Pit card shell around CPChart.
//
// Replaces the licensed TradingView Advanced Chart widget for US EQUITIES ONLY. The futures blocks
// further down that page still use the widget, deliberately: they address TradingView symbols
// ("CME_MINI:ES1!") and our licensed data is Tiingo daily plus Polygon equity aggregates, which
// covers neither futures continuations nor their symbology. Swapping those would produce an empty
// chart, so they are left alone until a futures source exists.
export default function TickerPriceChart({ symbol }) {
  const router = useRouter();
  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Price chart</span>
      </div>
      {/* A real height: the chart autosizes to its host, and a host with no height renders nothing. */}
      <div style={{ padding: 14, height: 'clamp(460px, 62vh, 700px)', display: 'flex', flexDirection: 'column' }}>
        {/* HERE the page owns the symbol, so picking one in the chart navigates to that ticker's
            page rather than leaving this chart on a symbol the rest of the page is not about. In a
            Terminal panel the chart owns it instead and nothing navigates — see CPChart. */}
        {/* One candle per trading day, five years of them — the same default every chart opens on. */}
        <CPChart symbol={symbol} initialTimeframe="1D" transparent
          onSymbolPick={(s) => router.push(`/ticker/${encodeURIComponent(s)}`)} />
      </div>
    </div>
  );
}
