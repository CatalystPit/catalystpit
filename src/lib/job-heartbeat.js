import { sql } from 'drizzle-orm';
import { db } from './db';

// JOB HEARTBEATS — "did this clock actually tick", recorded where we already record it.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Every news feed already writes last_success_at to `feed_state`, so "is the wire alive" has had a
// one-query answer for a long time. The STRUCTURED ingest jobs — Form 4, 8-K, Congress, 13F,
// quotes, Consensus, alerts — wrote nothing of the kind. Their liveness could only be inferred
// from the freshness of the rows they produce, and that inference silently breaks every weekend
// and every holiday: SEC publishes nothing on a Sunday, so "newest filing is 3 days old" is
// indistinguishable from "the job has been throwing for 3 days". Proving the difference meant
// fetching EDGAR by hand and comparing, which is what this file removes the need to do.
//
// ── WHY NOT A NEW TABLE ─────────────────────────────────────────────────────
//
// `feed_state` already stores exactly these columns — last_polled_at, last_success_at, last_status,
// consecutive_failures, events_seen, note — and /api/health already exists to read them. A second
// table would mean two half-answers to one question. Job rows are namespaced `job:<name>` so they
// are trivially separable from the RSS/API feeds that share the table, and nothing that reads feed
// rows has to learn about jobs.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
//
// A heartbeat records that the job RAN AND SUCCEEDED, not that it found anything. `seen: 0` is a
// perfectly healthy Sunday. Recording success on a run that inserted nothing is the entire point:
// it separates "no new filings exist" from "we stopped asking".
//
// ⚠️ A HEARTBEAT MUST NEVER FAIL ITS JOB. It is bookkeeping — if the write throws, the ingest it
// describes has already done the real work, and losing a timestamp must not turn a successful run
// into a 500. Every call swallows its own error and says so in the log.

/** `job:` so a heartbeat can never collide with a feed key in the same table. */
export const jobKey = (name) => `job:${String(name || '').trim()}`;

/**
 * ⚠️ THE NOTE IS PUBLIC. ENFORCE "NEVER AN ERROR DUMP" HERE, NOT IN EVERY CALLER.
 *
 * /api/health serves these notes to anyone, unauthenticated. The contract above already says a note
 * is "short human note; truncated, and never an error dump" — and it was being violated in
 * production: the dividends job's note was
 *
 *   'Failed query: \n      insert into dividend_events (\n        source, source_event_id, ticker,
 *    cik,\n        declaration_date, ex_dividend_date, record_date, payment_date,\n        cash'
 *
 * i.e. a public endpoint publishing our table and column names, because one caller passed
 * `e.message` where every other caller passes a fixed string ('ingest threw', 'sync threw').
 *
 * A caller cannot be trusted to remember this, so the rule lives at the write. Whitespace is
 * collapsed — which alone destroys the multi-line query shape — and anything still carrying the
 * shape of a dumped statement is replaced outright. Every legitimate note in the codebase is a short
 * human phrase ('no watchers matched', '83 rows / 3324 candidates in 60s') and passes through
 * untouched.
 */
export function safeNote(note) {
  if (note == null) return null;
  const flat = String(note).replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (/failed query|\binsert into\b|\bselect\b[\s\S]*\bfrom\b|\bupdate\b[\s\S]*\bset\b|\bdelete from\b|\brelation\b.*does not exist|\bcolumn\b.*does not exist/i.test(flat)) {
    return 'query failed — detail in logs';
  }
  return flat.slice(0, 200);
}

/**
 * Record one run of a named job.
 *
 * @param {string} name    stable job name, e.g. 'form4', 'eightk', 'congress-sync'
 * @param {object} o
 * @param {boolean} o.ok   did the run complete without throwing
 * @param {number} o.seen  rows/filings written this run (0 is healthy and expected off-hours)
 * @param {string} o.note  short human note; truncated, and never an error dump
 */
export async function recordJobRun(name, { ok = true, seen = 0, note = null } = {}) {
  const key = jobKey(name);
  try {
    await db.execute(sql`
      insert into feed_state (feed_key, last_polled_at, last_success_at, last_status,
        consecutive_failures, events_seen, note)
      values (${key}, now(), ${ok ? sql`now()` : sql`null`}, ${ok ? 200 : 500},
        ${ok ? 0 : 1}, ${Number(seen) || 0}, ${safeNote(note)})
      on conflict (feed_key) do update set
        last_polled_at = now(),
        -- Only a SUCCESSFUL run moves the success clock. A failing job keeps its last good
        -- timestamp so the age of the outage stays readable instead of resetting every attempt.
        last_success_at = case when ${!!ok} then now() else feed_state.last_success_at end,
        last_status = excluded.last_status,
        consecutive_failures = case when ${!!ok} then 0 else feed_state.consecutive_failures + 1 end,
        events_seen = feed_state.events_seen + ${Number(seen) || 0},
        note = excluded.note`);
  } catch (e) {
    console.log(`[heartbeat] ${key} not recorded: ${e.message}`);
  }
}

/**
 * The jobs whose clocks are expected to tick, and how long a silence is tolerable.
 *
 * `maxAgeHours` is the SILENCE budget, not a freshness budget — it asks "when did this job last
 * run successfully", never "how new is the data". That is why weekend-quiet SEC jobs still carry
 * tight windows: EDGAR publishes nothing on a Sunday, but the poller is still supposed to poll.
 *
 * `weekdaysOnly` marks jobs whose cron deliberately does not run at weekends, so a Sunday check
 * reports them as idle-by-design rather than broken.
 */
export const TRACKED_JOBS = Object.freeze([
  { name: 'form4',          label: 'Insiders / Form 4',      maxAgeHours: 2 },
  { name: 'eightk',         label: '8-K wire',               maxAgeHours: 2 },
  { name: 'congress-sync',  label: 'Congress disclosures',   maxAgeHours: 6 },
  { name: 'institutions',   label: '13F universe',           maxAgeHours: 26 },
  { name: 'consensus-board', label: 'Consensus materialize', maxAgeHours: 2 },
  { name: 'quotes',         label: 'Quotes / EOD candles',   maxAgeHours: 26 },
  { name: 'alerts',         label: 'Alerts evaluation',      maxAgeHours: 24, weekdaysOnly: true },
  { name: 'insider-alerts', label: 'Insider alert emails',   maxAgeHours: 2 },
  { name: 'evidence-alerts', label: 'Evidence alerts',       maxAgeHours: 2 },
  { name: 'refresh-content', label: 'News enrichment',       maxAgeHours: 24, weekdaysOnly: true },
  // ⚠️ THIS ONE RECORDS A VERDICT, NOT JUST A TICK. The heatmap rollover check writes ok:false when
  // it FINDS something — a completed session whose EOD data never loaded — so a green clock here
  // means both "the check ran" and "the board is on the session it should be on". Every other job
  // in this table reports only the first of those.
  //
  // Hourly cron, so 3h of silence is three missed runs: late enough not to flap on one cold start,
  // tight enough that the checker going dark is itself visible. NOT weekdaysOnly — Friday's session
  // loads on Saturday, so the weekend is exactly when a missing ingest must still be caught.
  { name: 'heatmap-gate',   label: 'Heatmap EOD rollover',   maxAgeHours: 3 },
  // Daily after the close, so 26h tolerates one late run without flapping. NOT weekdaysOnly: it
  // runs every day and simply recomputes the same last completed session at a weekend, which is
  // the cheapest way to keep the clock meaningful seven days a week.
  { name: 'fear-greed',     label: 'Fear & Greed index',     maxAgeHours: 26 },

  // ── ADDED FOR LAUNCH MONITORING ────────────────────────────────────────────
  //
  // ⚠️ TWO OF THESE WERE ALREADY WRITING HEARTBEATS NOBODY READ. market-breadth and score-conviction
  // called recordJobRun from the day they shipped, but were never added here — so the row existed,
  // /api/health never looked at it, and the job could have been dead for a week silently. A heartbeat
  // that nothing reads is worse than none: it looks like coverage.
  //
  // Daily crons get 26h, which tolerates one late run without flapping. market-breadth is NOT
  // weekdaysOnly even though its own cron is weekdays-only, because it also runs nightly off the end
  // of screener-technicals — so it should tick every day, and a weekend of silence is real.
  { name: 'market-breadth', label: 'Market breadth snapshot', maxAgeHours: 26 },
  { name: 'score-conviction', label: 'Insider conviction scoring', maxAgeHours: 26 },
  { name: 'screener',       label: 'Screener rebuild',        maxAgeHours: 26 },
  { name: 'screener-technicals', label: 'Screener technicals backfill', maxAgeHours: 26 },
  { name: 'institutions-ownership', label: '13F ownership rollup', maxAgeHours: 26 },
  { name: 'dividends',      label: 'Dividend calendar',       maxAgeHours: 26 },
  // Every minute. 2h of silence is ~120 missed runs — late enough to survive a deploy or a cold
  // start, tight enough that the wire going quiet is visible the same morning.
  { name: 'primary-sources', label: 'Pit Wire primary sources', maxAgeHours: 2 },

  // ⚠️ EVENT-DRIVEN, SO IT HAS NO CADENCE TO BE LATE AGAINST. The Stripe webhook fires when somebody
  // subscribes, cancels or is billed — and at launch that may be days apart. Giving it a maxAgeHours
  // would report "no subscriptions this week" as an outage, which is the precise mistake of calling a
  // quiet source a broken one. What IS a fault is the endpoint erroring on events it did receive, so
  // this one is judged on consecutive failures alone.
  { name: 'stripe-webhook', label: 'Stripe webhook processing', eventDriven: true },
  // Same shape, same reason: signups arrive when they arrive. A quiet Tuesday is not an outage, but
  // an endpoint rejecting the deliveries it does get — or running without its signing secret — is.
  { name: 'clerk-webhook',  label: 'Clerk signup webhook',      eventDriven: true },
]);

/**
 * Read every job heartbeat in one query. Returns a Map keyed by job NAME.
 *
 * ⚠️ A PREFIX MATCH, NOT `= any($1)`. Drizzle's sql template does not bind a JS array to a
 * Postgres text[], so the any() form threw instantly in production (14ms) and /api/health
 * reported `probe_failed` for liveness — the one check whose whole job is noticing silence was
 * itself silently broken. `like 'job:%'` needs no array binding, and it has the better property
 * of returning heartbeats written under a name nobody tracks any more, instead of hiding them.
 */
export async function readJobHeartbeats() {
  const res = await db.execute(sql`
    select feed_key, last_polled_at, last_success_at, last_status, consecutive_failures, events_seen, note
      from feed_state where feed_key like 'job:%'`);
  const out = new Map();
  for (const r of (res.rows ?? res)) out.set(String(r.feed_key).replace(/^job:/, ''), r);
  return out;
}
