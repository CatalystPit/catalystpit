import { pageMeta } from '../../lib/seo';
import PrivacyClient from './PrivacyClient';

// Server wrapper: a 'use client' file cannot export metadata, so the page's own title,
// description and canonical live here and the interactive component sits alongside.
export const metadata = pageMeta({
  title: "Privacy Policy",
  description: "How CatalystPit collects, uses and protects your information, including account data, analytics and third-party services.",
  path: "/privacy",
});

export default function Page() {
  return <PrivacyClient />;
}
