import InstitutionsClient from './InstitutionsClient';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: "Institutions · CatalystPit" },
  description: "What the biggest funds and managers hold, from quarterly SEC 13F filings, with holdings and quarter-over-quarter activity.",
  path: "/institutions",
});

export default function InstitutionsPage() {
  return <InstitutionsClient />;
}
