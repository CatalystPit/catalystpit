// OFFICIAL OCC EQUITY-OPTIONS VOLUME — the only source of the Options Sentiment component.
//
// ── ⚠️ WHAT THIS READS, AND WHY IT IS THIS ENDPOINT ─────────────────────────
//
// https://marketdata.theocc.com/mdapi/daily-volume-totals?report_date=YYYY-MM-DD
//
// OCC's own machine-readable daily volume. JSON, no HTML parsing, no vendor in between. The payload
// partitions cleared volume into `equity_volume`, `index_volume`, `debt_volume` and
// `futures_volume`, each as per-exchange rows plus a Total. We read `equity_volume` and nothing
// else, which is what separates equity-class options from INDEX options.
//
// ⚠️ BUT EQUITY CLASS IS NOT SINGLE-NAME. Measured 2026-09-23: equity_volume was 67,230,969
// contracts, 90.7% of all cleared options — single names AND exchange-traded products together.
// Its ratio that session was 0.80, sitting between Cboe published equity 0.46 and Cboe published
// ETP 1.17, exactly as a volume blend of the two does. There is no OCC bucket that isolates single
// names, so this component measures overall equity-class options posture and its public wording
// says so. Anyone tempted to describe it as speculation-only should read this paragraph first.
//
// ⚠️ THE OTHER OCC ENDPOINT DOES NOT WORK FOR THIS. /volume-query is documented with accountType
// (C/F/M) and productKind=OSTK, which would have given a customer-only series. Its validator
// accepts only volumeQueryType=O, and symbolType is restricted to O or U — both of which then
// demand a specific SYMBOL. There is no market-wide aggregate, and every well-formed aggregate
// request returns HTTP 500. So a CUSTOMER-only put/call ratio is not obtainable from a working
// official OCC interface, and this component is all-account cleared volume. Stated, not glossed.
//
// ── ⚠️ EVERY NUMBER IS CHECKED AGAINST OCC'S OWN ARITHMETIC ─────────────────
//
// A response is accepted only when it proves itself internally: the Total row must equal the sum of
// the exchange rows, calls + puts must equal the stated volume, and OCC's own published ratio must
// agree with puts/calls. A payload that fails any of those is INCOMPLETE, and an incomplete payload
// is missing — never a partial number.
//
// ⚠️ AND NOTHING IS EVER MANUFACTURED. A session OCC has not published returns null. A weekend or
// a market holiday returns null, because the endpoint correctly returns no equity rows for one.
// There is no interpolation, no forward-fill, no substitution from another source, and no neutral
// default anywhere in this file.

const ENDPOINT = 'https://marketdata.theocc.com/mdapi/daily-volume-totals';
export const OCC_SOURCE = 'occ:daily-volume-totals';
/** Declared so OCC can see who is asking. */
const UA = process.env.OCC_USER_AGENT || 'CatalystPit market-data (bcoghill88@gmail.com)';

/**
 * ⚠️ OCC PUBLISHES ON A LAG, AND THE COMPONENT LIVES WITH IT RATHER THAN PAPERING OVER IT.
 *
 * Measured 2026-09-26: the most recent published session was 2026-09-23, with 09-24 and 09-25 not
 * yet available — and the /volume-query validator says the same ("Report date cannot be greater
 * than 09/23/2026"). So a session's options volume is public roughly two business days later.
 *
 * The consequence is deliberate and visible: the newest sessions carry no Options Sentiment until
 * OCC publishes them, the index runs on the components it has, and the next nightly build fills
 * them in. That is the existing missing-component rule doing its job. The alternative — holding
 * yesterday's ratio over into today — would present a stale number as current, which is the one
 * thing this component must never do.
 */
export const OCC_TYPICAL_LAG_SESSIONS = 2;

const rowsOf = (v) => (Array.isArray(v) ? v : []);
const totalOf = (list) => rowsOf(list).find((r) => String(r.exchange || '').trim() === 'Total') || null;
const members = (list) => rowsOf(list).filter((r) => String(r.exchange || '').trim() !== 'Total');

/**
 * Parse one OCC payload into an equity-options observation, or null.
 *
 * Exported so the validation can be exercised against hand-written payloads without a network.
 *
 * @returns {{calls,puts,volume,exchanges,ratio}|null} null when the session is absent or the
 *          payload fails its own arithmetic — both are MISSING, never a guess.
 */
export function parseEquityVolume(payload) {
  const equity = payload?.entity?.equity_volume;
  const total = totalOf(equity);
  if (!total) return null;                     // weekend, holiday, or not yet published

  const calls = Number(total.calls);
  const puts = Number(total.puts);
  const volume = Number(total.volume);
  if (!Number.isFinite(calls) || !Number.isFinite(puts) || calls <= 0 || puts < 0) return null;

  // ⚠️ THE TOTAL MUST BE THE TOTAL. A truncated response would otherwise pass as a smaller market.
  const parts = members(equity);
  if (parts.length < 2) return null;
  const sumCalls = parts.reduce((a, r) => a + Number(r.calls || 0), 0);
  const sumPuts = parts.reduce((a, r) => a + Number(r.puts || 0), 0);
  if (sumCalls !== calls || sumPuts !== puts) return null;
  if (Number.isFinite(volume) && calls + puts !== volume) return null;

  // ⚠️ AND OUR RATIO MUST BE OCC'S RATIO. They publish it to two decimals; if our division
  // disagrees with their own number we are reading the wrong field.
  const ratio = puts / calls;
  const published = Number(total.ratio);
  if (Number.isFinite(published) && Math.abs(published - ratio) > 0.015) return null;

  return { calls, puts, volume: calls + puts, exchanges: parts.length, ratio };
}

/**
 * One session's official equity-options volume.
 *
 * @param {string} date YYYY-MM-DD, a real market session
 * @returns {Promise<{date,calls,puts,volume,exchanges,ratio,retrievedAt,source}|null>}
 */
export async function fetchEquityVolume(date, { retries = 3, timeoutMs = 20000 } = {}) {
  const day = String(date).slice(0, 10);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${ENDPOINT}?report_date=${day}`,
        { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(timer);
      // ⚠️ A TRANSPORT FAILURE IS NOT AN EMPTY SESSION. Retry, then report missing — never write a
      // row that says "no options traded" because a request timed out.
      if (!res.ok) { await wait(attempt); continue; }
      const json = await res.json();
      if (json?.status && json.status !== 200) return null;   // OCC's own "no data" answer
      const parsed = parseEquityVolume(json);
      if (!parsed) return null;
      return { date: day, ...parsed, retrievedAt: new Date().toISOString(), source: OCC_SOURCE };
    } catch {
      await wait(attempt);
    }
  }
  return null;
}

const wait = (attempt) => new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
