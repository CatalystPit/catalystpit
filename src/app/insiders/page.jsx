import { pageMeta } from '../../lib/seo';
import InsidersClient from './InsidersClient';

// Server wrapper: a 'use client' file cannot export metadata, so the page's own title,
// description and canonical live here and the interactive component sits alongside.
export const metadata = pageMeta({
  title: "Insider Trades · Form 4 Filings",
  description: "Open-market insider buys and sells from SEC Form 4 filings, with cluster buys, CEO and CFO activity, and dollar values by company and sector.",
  path: "/insiders",
});

export default function Page() {
  return <InsidersClient />;
}
