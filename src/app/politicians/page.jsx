import PoliticiansList from './PoliticiansList';

export const metadata = {
  title: 'Politicians · CatalystPit',
  description: 'Congressional stock trades disclosed under the STOCK Act. Track what House and Senate members are buying and selling, and how each trade has performed since.',
};

export default function PoliticiansPage() {
  return <PoliticiansList />;
}
