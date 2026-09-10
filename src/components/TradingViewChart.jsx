'use client';
import { useEffect, useRef } from 'react';
import { C, Dot, useTheme } from '../lib/cp-shared';

// Production price chart = licensed TradingView Advanced Chart widget (plan A4). The widget
// fetches its own market data inside its iframe — none of our personal API keys are used.
// Structure mirrors TradingView's official embed: a FIXED-HEIGHT host → .tradingview-widget-container
// (100%) → .__widget (100%). autosize needs a resolved parent height or it renders tiny.
export default function TradingViewChart({ ticker }) {
  const hostRef = useRef(null);
  const theme = useTheme();
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    container.style.height = '100%';
    container.style.width = '100%';

    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    widget.style.height = '100%';
    widget.style.width = '100%';
    container.appendChild(widget);

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: ticker,
      interval: 'D',
      timezone: 'America/New_York',
      theme,
      style: '1',
      locale: 'en',
      hide_side_toolbar: false,
      allow_symbol_change: false,
      support_host: 'https://www.tradingview.com',
    });
    container.appendChild(script);
    host.appendChild(container);

    return () => { host.innerHTML = ''; };
  }, [ticker, theme]);

  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Price chart</span>
        <span style={{ marginLeft: 'auto', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px' }}>TRADINGVIEW</span>
      </div>
      {/* fixed-height host so the autosize widget has a real height to fill */}
      <div ref={hostRef} style={{ height: 'clamp(560px, 80vh, 840px)', width: '100%' }} />
    </div>
  );
}
