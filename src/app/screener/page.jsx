import { Suspense } from 'react';
import ScreenerClient from './ScreenerClient';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: "Stock Screener · CatalystPit" },
  description: "Screen the market by smart-money signals, technicals, price, and volume. A fast, composable stock screener.",
  path: "/screener",
});

export default function ScreenerPage() {
  return (
    <Suspense fallback={null}>
      <ScreenerClient />
    </Suspense>
  );
}
