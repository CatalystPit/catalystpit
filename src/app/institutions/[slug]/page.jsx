import FundProfile from './FundProfile';

export const metadata = {
  title: 'Fund holdings · CatalystPit',
  description: 'Latest 13F holdings and quarter-over-quarter activity for this institutional manager.',
};

export default async function Page({ params }) {
  const { slug } = await params;
  return <FundProfile slug={slug} />;
}
