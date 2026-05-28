import PoliticianDetail from './PoliticianDetail';

export const metadata = {
  title: 'Politician — CatalystPit',
  description: 'Congressional trade history and return-since-trade performance, disclosed under the STOCK Act.',
};

export default async function Page({ params }) {
  const { slug } = await params;
  return <PoliticianDetail slug={slug} />;
}
