import MarketsClient from './MarketsClient';

export const metadata = {
  title: 'Markets — CatalystPit',
  description: 'What\'s moving by catalyst today — names with fresh SEC filings, Congress trades, and headlines. No last-sale prices.',
};

export default function MarketsPage() {
  return <MarketsClient />;
}
