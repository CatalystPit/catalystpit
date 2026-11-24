import MarketsClient from './MarketsClient';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  // The same literal-backslash defect as /news, from the same unnecessary escape.
  title: { absolute: "Market Catalysts Today · Stocks With Fresh SEC Filings and Congress Trades · CatalystPit" },
  description: "What is moving by catalyst today: companies with fresh SEC filings, Congressional trades and headlines, grouped by the evidence that put them on the list.",
  path: "/markets",
});

export default function MarketsPage() {
  return <MarketsClient />;
}
