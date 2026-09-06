'use client';
import { useEffect, useRef } from 'react';
import { C, Dot } from '../lib/cp-shared';

// Production price chart = licensed TradingView widget (plan A4 / "production display =
// EDGAR + widget"), replacing self-plotted Polygon/Tiingo bars. The widget fetches its
// own market data inside its iframe — none of our personal API keys are used here.
export default function TradingViewChart({ ticker }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '';
    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    widget.style.height = '100%'; widget.style.width = '100%';
    el.appendChild(widget);
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.innerHTML = JSON.stringify({
      symbol: ticker, autosize: true, interval: 'D', timezone: 'America/New_York',
      theme: 'light', style: '1', locale: 'en', hide_side_toolbar: false,
      allow_symbol_change: false, support_host: 'https://www.tradingview.com',
    });
    el.appendChild(script);
    return () => { el.innerHTML = ''; };
  }, [ticker]);

  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Price chart</span>
        <span style={{ marginLeft: 'auto', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px' }}>TRADINGVIEW</span>
      </div>
      <div ref={ref} className="tradingview-widget-container" style={{ height: 420, width: '100%' }} />
    </div>
  );
}
