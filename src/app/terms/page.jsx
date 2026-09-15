import { pageMeta } from '../../lib/seo';
import TermsClient from './TermsClient';

// Server wrapper: a 'use client' file cannot export metadata, so the page's own title,
// description and canonical live here and the interactive component sits alongside.
export const metadata = pageMeta({
  title: "Terms of Service",
  description: "The terms governing use of CatalystPit, including account rules, subscriptions, acceptable use and limitations of liability.",
  path: "/terms",
});

export default function Page() {
  return <TermsClient />;
}
