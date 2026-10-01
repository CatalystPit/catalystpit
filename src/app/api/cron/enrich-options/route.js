// CONGRESSIONAL OPTION PRICING IS RETIRED — NO LICENSED OPTIONS SOURCE EXISTS.
//
// ⚠️ WHAT THIS WAS. Disclosed option trades were priced from Polygon option aggregates to produce a
// leveraged return for the leaderboard. It had already been disabled behind a flag, and the measured
// result of that is in the data: 0 of 7,925 congressional trades carry an option price. So no user has
// ever seen a figure derived from it.
//
// ⚠️ WHY THE CODE GOES RATHER THAN THE FLAG. A disabled route with a working vendor client inside it
// is one line from being live, and this repository has now been audited twice; the Twelve Data branch in
// market-data.js is what "dormant but ready" looks like after a few months. lib/congress-options.mjs is
// deleted with it.
//
// ⚠️ AND THERE IS NOTHING TO MIGRATE TO. Tiingo's entitlement is equities. The three tempting
// substitutions are all worse than doing nothing: pricing an option from the UNDERLYING equity is a
// different instrument, reusing the last Polygon values serves unlicensed data one step removed, and
// interpolating is fabrication. Congressional EQUITY trades are unaffected and keep pricing from our own
// licensed daily closes.
//
// The route is retained because vercel.json schedules it; it returns immediately and records nothing.

export const runtime = 'nodejs';

export async function GET() {
  return Response.json({
    ok: true,
    disabled: true,
    priced: 0,
    reason: 'options pricing requires a licensed options data source; none is approved',
  });
}
