import ComingSoon from '../../components/ComingSoon';

export const metadata = {
  title: 'News — CatalystPit',
  description: 'Real-time financial news, categorized and searchable. Built for active traders who can\'t afford to miss a catalyst.',
};

export default function NewsPage() {
  return (
    <ComingSoon
      title="Live News"
      tagline="Every catalyst, the moment it breaks."
      description="A real news feed built for traders, not consumers. Categorized by sector, filtered by ticker, refreshed continuously. The signal you need without the noise you don't."
      features={[
        "Real-time financial wire — earnings, macro, M&A, breaking",
        "Filter by ticker, sector, or category — surface what matters",
        "Search the full archive across every catalyst we've covered",
        "Pro: instant alerts when news drops on your watchlist",
      ]}
    />
  );
}
