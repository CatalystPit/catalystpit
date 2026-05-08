import ComingSoon from '../../components/ComingSoon';

export const metadata = {
  title: 'Charts — CatalystPit',
  description: 'Interactive live charts with real-time data, multiple timeframes, and technical indicators. Coming soon to CatalystPit.',
};

export default function ChartsPage() {
  return (
    <ComingSoon
      title="Live Charts"
      tagline="Read the tape. Make the call."
      description="Interactive candlestick charts on every U.S. ticker with the timeframes and indicators that matter for active trading. Built into the same workflow as your screener, watchlist, and catalyst feed — no app-switching."
      features={[
        "Every U.S. ticker with intraday and historical data",
        "Multiple timeframes: 1m, 5m, 1h, 1D, 1W",
        "Moving averages, volume, and key technical overlays",
        "One-click chart from any ticker on your watchlist",
      ]}
    />
  );
}
