import ComingSoon from '../../components/ComingSoon';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: "Crypto · CatalystPit" },
  description: "Live crypto prices, on-chain catalysts, and market intelligence for active digital asset traders.",
  path: "/crypto",
  // ⚠️ A "COMING SOON" PAGE IS A THIN PAGE, AND IT WAS index, follow. It carries a heading, a
  // paragraph about what the feature WILL do, and no product — the textbook shape Google treats as
  // thin or as a doorway, and it competes for our own brand terms against rooms that do have
  // something behind them. noindex keeps it reachable for anyone who follows a link and keeps it
  // out of the index until there is a product to index. follow is retained so the links on it
  // still pass through. Remove this the day the feature ships.
  robots: { index: false, follow: true },
});

export default function CryptoPage() {
  return (
    <ComingSoon
      title="Crypto"
      tagline="The catalysts that move digital assets."
      description="Live prices, on-chain signals, and the catalysts driving the crypto market, built with the same intelligence-first approach as the rest of CatalystPit. Track BTC, ETH, and the majors alongside your equities, all in one place."
      features={[
        "Live prices for BTC, ETH, and major altcoins",
        "On-chain signals: whale moves, exchange flows, funding rates",
        "Catalyst feed: protocol upgrades, ETF news, regulatory updates",
        "Cross-asset view: see crypto and equities side by side",
      ]}
    />
  );
}
