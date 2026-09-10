'use client';
import { useEffect, useRef } from 'react';
import { useTheme } from '../lib/cp-shared';

// Compact daily candlestick chart (TradingView advanced-chart embed, style 1, toolbars stripped).
// Themes live via useTheme. Used for the homepage index tiles (S&P / Nasdaq / Dow / VIX).
export default function MiniCandles({ symbol, height = 150, range = '3M' }) {
  const host = useRef(null);
  const theme = useTheme();
  useEffect(() => {
    const h = host.current; if (!h) return; h.innerHTML = '';
    const c = document.createElement('div'); c.className = 'tradingview-widget-container'; c.style.height = '100%'; c.style.width = '100%';
    const w = document.createElement('div'); w.className = 'tradingview-widget-container__widget'; w.style.height = '100%'; w.style.width = '100%'; c.appendChild(w);
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    s.async = true;
    s.innerHTML = JSON.stringify({
      autosize: true, symbol, interval: 'D', range, timezone: 'America/New_York', theme,
      style: '1', locale: 'en', hide_top_toolbar: true, hide_side_toolbar: true, hide_legend: true,
      allow_symbol_change: false, save_image: false, withdateranges: false, support_host: 'https://www.tradingview.com',
    });
    c.appendChild(s); h.appendChild(c);
    return () => { h.innerHTML = ''; };
  }, [symbol, theme, range]);
  return <div style={{ position: 'relative', height, width: '100%' }}><div ref={host} style={{ position: 'absolute', inset: 0 }} /></div>;
}
