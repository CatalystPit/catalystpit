import ProfileView from './ProfileView';

export async function generateMetadata({ params }) {
  const { handle } = await params;
  return {
    title: `@${handle} — CatalystPit`,
    description: `${handle}'s profile on CatalystPit — The Pit community.`,
  };
}

export default async function ProfilePage({ params }) {
  const { handle } = await params;
  return <ProfileView handle={handle} />;
}
