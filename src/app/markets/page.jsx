import MarketsClient from './MarketsClient';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: "Markets · CatalystPit" },
  description: "What\\'s moving by catalyst today: names with fresh SEC filings, Congress trades, and headlines. No last-sale prices.",
  path: "/markets",
});

export default function MarketsPage() {
  return <MarketsClient />;
}
