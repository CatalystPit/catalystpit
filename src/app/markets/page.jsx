import ComingSoon from '../../components/ComingSoon';

export const metadata = {
  title: 'Markets — CatalystPit',
  description: 'Full market overview — indices, sectors, futures, and macro. The pulse of the entire market in one place.',
};

export default function MarketsPage() {
  return (
    <ComingSoon
      title="Markets"
      tagline="The whole tape, one screen."
      description="A comprehensive market overview built for active traders. Indices, sector rotation, futures, currencies, and macro — the pulse of the entire market in a single dashboard. See what's leading, what's lagging, and what's setting up next."
      features={[
        "Indices, sectors, and ETF heatmaps — see rotation in real-time",
        "Futures and pre-market action before the bell",
        "Macro calendar: Fed, CPI, jobs, earnings season",
        "Sector and industry leaders, laggards, and unusual moves",
      ]}
    />
  );
}
