import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { tickerCanonicalRedirect } from './lib/ticker-url-redirect.mjs';

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
const withClerk = clerkMiddleware(async (auth, req) => {
  if (!isProtectedRoute(req)) return;

  const { userId } = await auth();
  if (userId) return;

  const signIn = new URL('/sign-in', req.url);
  // ⚠️ PATH + QUERY, NOT JUST PATH. Dropping the query here would turn `/account?upgraded=1` into a
  // plain `/account` and lose the one signal that tells the page a payment just completed.
  signIn.searchParams.set('redirect_url', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(signIn);
});

// ── ⚠️ THE TICKER CASING REDIRECT ANSWERS HERE, AND THAT IS WHAT MAKES ~19,750 URLs CACHEABLE ─────
//
// It used to live in src/app/ticker/[symbol]/page.jsx, where preserving `?tab=` across the hop meant
// awaiting `searchParams` — and reading searchParams anywhere in a page opts the WHOLE route out of
// static rendering, for every request, including the overwhelming majority that are already
// canonical and never redirect. Measured on production at 41668bf7: every ticker URL answered
// `Cache-Control: private, no-cache, no-store` with `x-vercel-cache: MISS`, even on an immediate
// repeat, at a p50 of 673ms against 210ms for the prerendered homepage.
//
// Middleware already runs on these paths and can read the query string without any of that, so the
// redirect costs nothing and the page becomes ISR — see `revalidate` in page.jsx.
//
// ⚠️ IT RUNS BEFORE CLERK, DELIBERATELY. The decision is a pure function of the URL: it needs no
// session, no cookie and no network, so there is no reason for it to depend on Clerk having
// initialised. A missing or domain-locked CLERK_SECRET_KEY makes clerkMiddleware throw on every
// path — that is exactly what happens on a developer machine — and the ticker redirect keeps
// working through it. Nothing else changes order: every request that is NOT a non-canonical ticker
// URL reaches clerkMiddleware exactly as it did before, and the ones that are get a 308 with no
// body, where a session refresh had nothing to do anyway.
export default function middleware(req, event) {
  const to = tickerCanonicalRedirect({
    pathname: req.nextUrl.pathname,
    tab: req.nextUrl.searchParams.get('tab'),
  });
  // 308, not 307: the uppercase form is permanent, and a permanent redirect is what actually removes
  // /ticker/aapl from the index rather than leaving it there beside /ticker/AAPL.
  if (to) return NextResponse.redirect(new URL(to, req.url), 308);

  return withClerk(req, event);
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files
    '/((?!_next|[^?]*\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
