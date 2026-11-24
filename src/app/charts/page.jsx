import ComingSoon from '../../components/ComingSoon';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: "Charts · CatalystPit" },
  description: "Interactive live charts with real-time data, multiple timeframes, and technical indicators. Coming soon to CatalystPit.",
  path: "/charts",
  // ⚠️ A "COMING SOON" PAGE IS A THIN PAGE, AND IT WAS index, follow. It carries a heading, a
  // paragraph about what the feature WILL do, and no product — the textbook shape Google treats as
  // thin or as a doorway, and it competes for our own brand terms against rooms that do have
  // something behind them. noindex keeps it reachable for anyone who follows a link and keeps it
  // out of the index until there is a product to index. follow is retained so the links on it
  // still pass through. Remove this the day the feature ships.
  robots: { index: false, follow: true },
});

export default function ChartsPage() {
  return (
    <ComingSoon
      title="Live Charts"
      tagline="Read the tape. Make the call."
      description="Interactive candlestick charts on every U.S. ticker with the timeframes and indicators that matter for active trading. Built into the same workflow as your screener, watchlist, and catalyst feed, with no app-switching."
      features={[
        "Every U.S. ticker with intraday and historical data",
        "Multiple timeframes: 1m, 5m, 1h, 1D, 1W",
        "Moving averages, volume, and key technical overlays",
        "One-click chart from any ticker on your watchlist",
      ]}
    />
  );
}
