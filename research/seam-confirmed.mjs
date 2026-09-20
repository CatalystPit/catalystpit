// The vendor-confirmed adjustment-seam tickers, from research/price-seam-definitive.mjs.
//
// A repair acts on a REVIEWED list, never on whatever a detector returns today — findSeamCandidates
// narrows 2.8M bars to a candidate set, and confirmation is a separate, deliberate step. This list
// is that confirmation.
//
// It lives alone in its own module so importing it cannot execute anything: the snapshot script
// exported it first, and importing that from the repair script ran the whole snapshot (top-level
// await plus a process.exit) before the repair could start.
export const CONFIRMED = Object.freeze([
  'KO', 'JNJ', 'PG', 'MSFT', 'QQQ', 'INTC', 'CAT', 'AVGO', 'MA', 'LLY',
  'DHI', 'COST', 'GE', 'GOOGL', 'DAL', 'AMAT',
]);
