import ComingSoon from '../../components/ComingSoon';

export const metadata = {
  title: 'Crypto · CatalystPit',
  description: 'Live crypto prices, on-chain catalysts, and market intelligence for active digital asset traders.',
};

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
