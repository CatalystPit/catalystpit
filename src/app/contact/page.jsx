import { pageMeta } from '../../lib/seo';
import ContactClient from './ContactClient';

// Server wrapper: a 'use client' file cannot export metadata, so the page's own title,
// description and canonical live here and the interactive component sits alongside.
export const metadata = pageMeta({
  title: "Contact",
  description: "Get in touch with the CatalystPit team about the product, data coverage, corrections or press enquiries.",
  path: "/contact",
});

export default function Page() {
  return <ContactClient />;
}
