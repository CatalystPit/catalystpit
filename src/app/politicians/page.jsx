import PoliticiansList from './PoliticiansList';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: "Congress Stock Trades · STOCK Act Disclosures by Member · CatalystPit" },
  description: "Congressional stock trades disclosed under the STOCK Act. Track what House and Senate members are buying and selling, and how each trade has performed since.",
  path: "/politicians",
});

export default function PoliticiansPage() {
  return <PoliticiansList />;
}
