// EVIDENCE ALERT RULES — what is worth interrupting someone for, and what makes an event unique.
//
// PURE. No database, no network, no clock, no React. The orchestration lives in evidence-alerts.js,
// which needs Postgres and the notification tables; everything that can be DECIDED without them is
// decided here, so it can be tested directly rather than through a mock of the whole pipeline.

/** The families that are worth interrupting someone for. 13F is deliberately absent — see below. */
export const ALERTABLE_FAMILIES = Object.freeze(['catalyst', 'insider', 'congress']);

// ⚠️ 13F IS NOT AN ALERT. A quarterly snapshot disclosed up to 45 days late is not something to
// interrupt anyone for; it is context, and it is already on the ticker timeline and in What
// Changed. Alerting on it would be the firehose this feature exists to avoid.

/** How far back each pass looks. Generous on purpose — the primary key makes overlap free. */
export const LOOKBACK_HOURS = 48;
/** Never resolve more watched names than this in one pass. */
export const MAX_TICKERS = 40;
/** Resolver calls in flight. Each is several queries. */
export const CONCURRENCY = 4;
/** A single pass will not write more than this many notifications, however much has landed. */
export const MAX_ALERTS_PER_RUN = 50;

/**
 * The key that makes an event unique to a user.
 *
 * ⚠️ THE ACCESSION, NOT THE SUMMARY. `sourceId` is the SEC accession for 8-K and Form 4, and the
 * disclosure's own id for Congress — a stable identifier for the DOCUMENT. Keying on summary text
 * would re-alert whenever the engine reworded a sentence, and keying on evidenceId alone would
 * miss the overlap with the Form 4 mailer, which knows accessions and nothing about evidence
 * objects.
 */
export function alertKey(ev) {
  const id = ev?.sourceId || ev?.evidenceId;
  return id ? `${ev.family}:${id}` : null;
}

/**
 * The key the Form 4 mailer writes, so one filing cannot produce both an email and a bell.
 *
 * It must equal alertKey() for the same filing. That is asserted, because the whole overlap
 * guarantee rests on these two strings being identical rather than merely similar.
 */
export const insiderAccessionKey = (accession) => `insider:${accession}`;

/**
 * One line a person can act on: what, why it is notable, when it became public.
 *
 * ⚠️ publicTime, ALWAYS. For Congress that is the disclosure — the transaction can be 289 days
 * earlier in our real data, and an alert dated to it would describe information nobody outside
 * Congress had. The engine has already settled which clock this is; nothing here reaches past it.
 */
export function alertBody(ticker, ev) {
  const when = ev.publicTime
    ? new Date(ev.publicTime).toISOString().slice(0, 16).replace('T', ' ')
    : 'recently';
  const why = ev.context?.text ? ` · ${ev.context.text}` : '';
  return `${ticker}: ${ev.summary}${why} · public ${when} UTC`;
}
