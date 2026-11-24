/** @type {import('next').NextConfig} */

// ⚠️ FAIL FAST, BY NAME, WHEN THE CLERK PUBLISHABLE KEY IS ABSENT AT BUILD TIME.
//
// THE FAILURE THIS REPLACES. Two Vercel builds died with
//
//   Error: @clerk/nextjs: Missing publishableKey
//
// one while prerendering /account, one while prerendering /_not-found — and the page named in the
// error is INCIDENTAL. ClerkProvider wraps the root layout (src/app/layout.jsx), so every statically
// prerendered page needs NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, and the build reports whichever page it
// happened to reach first. Hours went into reading meaning into /account versus /_not-found; there was
// none. The two builds had the same single cause: the variable was not in the build environment.
//
// So the check runs before anything compiles, and says the one thing worth knowing. The old failure
// arrived two minutes in, pointed at a page that had nothing to do with it, and did not name the
// variable in a way anyone could act on.
//
// ⚠️ ONLY IN THE MAIN `next build` PROCESS, AND THE DETECTION WAS MEASURED RATHER THAN ASSUMED.
//
// The obvious test — NEXT_PHASE === 'phase-production-build' — DOES NOT WORK: probing the real config
// load on Next 15.3.8 shows NEXT_PHASE is undefined at the moment next.config.js is evaluated. argv is
// the signal that exists. The main build process runs .../node_modules/next/dist/bin/next with 'build';
// static generation then loads this same config inside jest-worker children whose argv[1] is
// processChild.js, and those are deliberately excluded — one clear failure beats the same message
// repeated once per worker.
//
// `next dev`, `next start`, lint and anything that merely imports this config are untouched. A config
// that throws in dev would be a worse bug than the one it guards against.
const argv = process.argv;
const isMainBuild = argv.includes('build') && /[\\/]next$/.test(argv[1] || '');
if (isMainBuild && !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
  throw new Error(
    'Build stopped: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set in this build environment.\n\n'
    + 'ClerkProvider wraps the root layout, so every statically prerendered page needs this key at\n'
    + 'BUILD time, not just at runtime. Without it the build fails deep inside static generation with\n'
    + '"@clerk/nextjs: Missing publishableKey" against an arbitrary page, which is misleading.\n\n'
    + 'On Vercel: Project Settings -> Environment Variables. The variable must be present for the\n'
    + 'environment being built -- Production AND Preview (and Development for `vercel dev`). A value\n'
    + 'scoped to Production only will build production and fail every preview branch.\n'
    + 'Environment changes do not apply to existing deployments; redeploy after saving.\n\n'
    + 'Locally: `export $(grep -v "^#" .env.build.local | xargs)` before `npx next build`.',
  );
}

const nextConfig = {
  // Ably's bundled build trips Next's swc client parser ("'super' outside a method").
  // Externalize it so server routes require it via Node (no webpack parse); the client
  // loads Ably from its official CDN instead of importing it (see PitChat.jsx).
  // 'ably' — bundled build trips Next's swc client parser; require it via Node instead.
  // 'unpdf' — serverless pdfjs build used by the congress House PTR parser; keep it external.
  serverExternalPackages: ['ably', 'unpdf'],

  // ⚠️ THE BULK OF THE SITE IS UNCACHEABLE, AND A headers() ENTRY DOES NOT FIX IT. MEASURED.
  //
  // /ticker/[symbol] — ~19,760 of the 19,767 URLs in our own sitemap — is served, as Googlebot:
  //
  //   cache-control: private, no-cache, no-store, max-age=0, must-revalidate
  //   x-vercel-cache: MISS      ← every request, including an immediate repeat
  //
  // while /insiders and /news come back HIT at age=178 and age=38567. Every crawl of a ticker page
  // reaches the origin and the database, and the response tells every intermediary not to store it.
  //
  // THE ATTEMPTED FIX IS RECORDED HERE BECAUSE IT FAILED, and a reader should not spend the same
  // hour on it. A `headers()` entry setting
  // `Cache-Control: public, s-maxage=300, stale-while-revalidate=3600` on '/ticker/:symbol' was
  // deployed and measured on production: the header did NOT take. For a route Next renders
  // dynamically, the framework's own Cache-Control is applied after config headers and wins. Dead
  // config that reads as if it works is worse than none, so it is not left in place.
  //
  // THE ACTUAL CAUSE is that the page reads searchParams — to preserve ?tab= across the
  // lowercase-to-uppercase permanent redirect — which opts the whole route into dynamic rendering
  // for every request, including the ~19,760 that never take the redirect branch.
  //
  // THE TWO FIXES THAT WOULD WORK, neither of them a one-line change and neither verifiable
  // locally (production Clerk keys are domain-locked, so `next start` 500s at middleware here):
  //
  //   1. Move the casing redirect into middleware, which already runs on these paths, and drop
  //      searchParams from the page. The route can then carry `export const revalidate` and be
  //      served from the ISR cache. Risk: middleware ordering with Clerk, and verify-ticker-urls
  //      has 187 assertions pinned to the current redirect behaviour.
  //   2. generateStaticParams for the top N symbols by traffic, leaving the long tail dynamic.
  //      Prerenders the pages that matter and leaves the measured problem for the rest.
  //
  // Not attempted blind. See the deployment report for the measurement.

  async redirects() {
    return [
      // ⚠️ THE RETIRED TERMINAL, REDIRECTED AT THE EDGE RATHER THAN BY RENDERING A PAGE.
      //
      // The branch replaced app/terminal/page.jsx with a `redirect('/markets')` call, which works but
      // issues a 307 from a rendered route: the URL stays a live page in the routing table, and a
      // temporary redirect tells crawlers to keep the old URL indexed. A retired surface wants a
      // permanent redirect so the link equity moves to /markets and /terminal leaves the index.
      //
      // Kept here rather than in middleware because middleware already runs Clerk on every matched
      // path, and a retired URL does not need an auth round trip to be redirected.
      { source: '/terminal', destination: '/markets', permanent: true },
      { source: '/terminal/:path*', destination: '/markets', permanent: true },
    ];
  },
};

export default nextConfig;
