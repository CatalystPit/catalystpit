import { auth, clerkClient } from '@clerk/nextjs/server';

export const runtime = 'nodejs';

// Is the signed-in user the configured admin (ADMIN_EMAIL)? Used to show/hide in-app admin controls.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

export async function GET() {
  const nostore = { 'Cache-Control': 'private, no-store' };
  try {
    const { userId } = await auth();
    if (!userId || !ADMIN_EMAIL) return Response.json({ admin: false }, { headers: nostore });
    const u = await (await clerkClient()).users.getUser(userId);
    const email = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress || u.emailAddresses[0]?.emailAddress;
    return Response.json({ admin: !!email && email.toLowerCase() === ADMIN_EMAIL.toLowerCase() }, { headers: nostore });
  } catch {
    return Response.json({ admin: false }, { headers: nostore });
  }
}
