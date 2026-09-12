import { Suspense } from 'react';
import ScreenerClient from './ScreenerClient';

export const metadata = {
  title: 'Stock Screener · CatalystPit',
  description: 'Screen the market by smart-money signals, technicals, price, and volume. A fast, composable stock screener.',
};

export default function ScreenerPage() {
  return (
    <Suspense fallback={null}>
      <ScreenerClient />
    </Suspense>
  );
}
