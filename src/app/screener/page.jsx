import ComingSoon from '@/components/ComingSoon';

export const metadata = {
  title: 'Screener — CatalystPit',
  description: 'Filter every U.S. stock by fundamentals, technicals, and catalyst signals. Coming soon to CatalystPit.',
};

export default function ScreenerPage() {
  return (
    <ComingSoon
      title="Screener"
      tagline="Find the next move before everyone else does."
      description="A real screener for active traders. Filter every U.S. stock by what actually matters — insider buying, politician trades, unusual options, earnings, fundamentals, technicals. Built for catalyst-driven trading, not endless P/E ratios."
      features={[
        "All U.S. stocks — fundamentals, technicals, and price data refreshed daily",
        "Filter by recent insider buys, politician disclosures, and earnings windows",
        "Save custom presets — your screens, one click",
        "Sort, paginate, share filter URLs with your team",
      ]}
    />
  );
}
