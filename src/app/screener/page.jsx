import ScreenerClient from './ScreenerClient';

export const metadata = {
  title: 'Stock Screener — CatalystPit',
  description: 'Screen the market by exchange, sector, market cap, price, and volume. A fast, clean stock screener.',
};

export default function ScreenerPage() {
  return <ScreenerClient />;
}
