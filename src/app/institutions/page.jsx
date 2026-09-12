import InstitutionsClient from './InstitutionsClient';

export const metadata = {
  title: 'Institutions · CatalystPit',
  description: 'What the biggest funds and managers hold, from quarterly SEC 13F filings, with holdings and quarter-over-quarter activity.',
};

export default function InstitutionsPage() {
  return <InstitutionsClient />;
}
