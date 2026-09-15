import { pageMeta } from '../../lib/seo';
import DisclaimerClient from './DisclaimerClient';

// Server wrapper: a 'use client' file cannot export metadata, so the page's own title,
// description and canonical live here and the interactive component sits alongside.
export const metadata = pageMeta({
  title: "Disclaimer",
  description: "CatalystPit publishes market data and filings for information only. Nothing on the site is financial advice or a recommendation to trade.",
  path: "/disclaimer",
});

export default function Page() {
  return <DisclaimerClient />;
}
