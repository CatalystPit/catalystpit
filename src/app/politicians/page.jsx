import ComingSoon from '../../components/ComingSoon';

export const metadata = {
  title: 'Politicians — CatalystPit',
  description: 'Congressional stock trades disclosed under the STOCK Act — sourced from official House and Senate financial disclosure filings.',
};

export default function PoliticiansPage() {
  return (
    <ComingSoon
      title="Politicians"
      tagline="Follow the money, not the rhetoric."
      description="Congressional stock trades disclosed under the STOCK Act — sourced directly from official House and Senate financial disclosure filings. Built for traders who want to know what their representatives are buying before the next news cycle."
      features={[
        "Real-time disclosures from House Clerk and Senate eFD filings",
        "Filter by chamber, party, committee, and transaction size",
        "Ticker-level view: see every member who traded a given stock",
        "Filing-to-trade lag tracking — who's reporting late and by how much",
      ]}
    />
  );
}
