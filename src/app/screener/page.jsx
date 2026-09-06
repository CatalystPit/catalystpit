import ScreenerClient from './ScreenerClient';

export const metadata = {
  title: 'Screener — CatalystPit',
  description: 'Scan insider filings by window, size, and direction. Preset Pit Scan surfaces recent open-market buys.',
};

export default function ScreenerPage() {
  return <ScreenerClient />;
}
