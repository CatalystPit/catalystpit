import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isProtectedRoute = createRouteMatcher([
  '/account(.*)',
  '/watchlist(.*)',
]);

// ── ⚠️ WHY THIS REDIRECTS INSTEAD OF LETTING auth.protect() 404 ─────────────
//
// `auth.protect()` with no signInUrl configured returns a bare 404 — deliberately, so a protected
// route is indistinguishable from one that does not exist. That is a reasonable default and the
// wrong one for us, because Stripe's success_url is `/account?upgraded=1`. A customer who has just
// paid and comes back without a usable session lands on "page not found" seconds after being
// charged. They cannot tell whether the payment worked, and nothing on the page suggests signing in.
//
// So a signed-out request for a protected page is sent to /sign-in with the original path in
// redirect_url, and Clerk returns them to it afterwards — including the `?upgraded=1` query, so the
// post-payment landing survives the detour.
//
// ⚠️ THIS DOES NOT WEAKEN ANYTHING. The route is still refused to signed-out users; only the
// REFUSAL CHANGED SHAPE, from a 404 to a sign-in prompt. Nothing about the account is rendered
// before authentication, and the API routes behind it keep their own independent auth checks — the
// middleware has never been the thing protecting account data.
export default clerkMiddleware(async (auth, req) => {
  if (!isProtectedRoute(req)) return;

  const { userId } = await auth();
  if (userId) return;

  const signIn = new URL('/sign-in', req.url);
  // ⚠️ PATH + QUERY, NOT JUST PATH. Dropping the query here would turn `/account?upgraded=1` into a
  // plain `/account` and lose the one signal that tells the page a payment just completed.
  signIn.searchParams.set('redirect_url', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(signIn);
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
