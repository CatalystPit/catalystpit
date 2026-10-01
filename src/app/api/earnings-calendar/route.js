// CONFIRMED FORWARD EARNINGS DATES HAVE NO APPROVED SOURCE, SO THIS SERVES NONE.
//
// ⚠️ WHAT THIS WAS. api.twelvedata.com/earnings_calendar, gated on TWELVE_DATA_API_KEY. The key is not
// set in production, so the panel has been showing its "connect data" state and no unlicensed data has
// reached a user through it — but the path was live code one environment variable from serving, and the
// same key would also have flipped lib/market-data.js's provider precedence onto Twelve Data for EVERY
// quote in the product. That is why this is removed rather than left dormant.
//
// ⚠️ AND NO OTHER VENDOR IS SUBSTITUTED. A forward earnings DATE is a company's own announcement; SEC
// carries filings after the fact, not a calendar of intentions. The product already infers the next
// likely date from filing cadence elsewhere and labels it as an estimate; what it will not do is state
// an unconfirmed date as confirmed. So this route keeps its contract and always answers "not
// configured", which the Terminal panel already renders cleanly.
//
// The route is retained rather than deleted because TerminalClient.jsx fetches it; returning a 404
// would turn an honest empty state into a console error.

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  return Response.json({
    configured: false,
    rows: [],
    reason: 'no licensed source for confirmed forward earnings dates',
  }, { headers: NO_STORE });
}
