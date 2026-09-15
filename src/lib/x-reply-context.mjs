// INTERNAL FACTS FOR AN AUTO-REPLY, and the generation call.
//
// Server-side. Everything here reads data Catalyst Pit already stores — no new provider, no paid
// call, nothing that is not already in the product. What comes back is the ONLY material a reply may
// be built from: the validator rejects any number that is not in it.

import { neon } from '@neondatabase/serverless';

let client = null;
const conn = () => (client ||= neon(process.env.DATABASE_URL));

export const MODEL = 'claude-haiku-4-5-20251001';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

/**
 * What do we actually know that bears on this post?
 *
 * Deliberately narrow. A reply is worth publishing only when we hold something the reader does not
 * already have from the post itself, so this gathers the handful of things that qualify and returns
 * nothing rather than padding.
 */
export async function buildReplyContext(ev) {
  const sql = conn();
  const tickers = (ev.tickers || []).filter(Boolean).slice(0, 2);
  const facts = { tickers };

  if (tickers.length) {
    const t = tickers[0];
    const [row] = await sql.query(`
      select
        (select to_jsonb(r) from (
           select date::text as date, close, volume from ticker_daily_candles
            where ticker = $1 order by date desc limit 1) r) as last_close,
        (select to_jsonb(r) from (
           select date::text as date, close from ticker_daily_candles
            where ticker = $1 order by date desc offset 1 limit 1) r) as prev_close,
        (select to_jsonb(r) from (
           select company, exchange, sector, market_cap from screener_stocks where ticker = $1) r) as identity,
        (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
           select executive, title, action, shares, total_value, transaction_date::text as d
             from insider_trades where ticker = $1 and is_amendment is not true
              and filing_date > current_date - 90
            order by total_value desc nulls last limit 3) r) as insider,
        (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
           select representative, party, action, amount_range, transaction_date::text as d
             from congress_trades where ticker = $1 and transaction_date > current_date - 180
            order by transaction_date desc limit 3) r) as congress,
        (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
           select headline, to_char(published_at,'YYYY-MM-DD') as d from primary_events
            where $1 = any(tickers) and cluster_id is null and display_ready
              and published_at > now() - interval '30 days' and seq <> $2
            order by published_at desc limit 4) r) as prior_events,
        (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
           select items, report_date::text as d from eightk_filings
            where ticker = $1 order by filed_at desc limit 2) r) as filings
      `, [t, ev.seq ?? 0]);
    Object.assign(facts, {
      identity: row?.identity ?? null,
      lastClose: row?.last_close ?? null,
      prevClose: row?.prev_close ?? null,
      insider: row?.insider ?? [],
      congress: row?.congress ?? [],
      priorEvents: row?.prior_events ?? [],
      filings: row?.filings ?? [],
    });
  }

  // For a macro or commodity line with no ticker, the only context we hold is our own record of the
  // same story: earlier canonical events sharing this event's entity.
  if (!tickers.length && ev.entity) {
    const prior = await sql.query(`
      select headline, to_char(published_at,'YYYY-MM-DD HH24:MI') as d
        from primary_events
       where entity = $1 and cluster_id is null and display_ready and seq <> $2
         and published_at > now() - interval '14 days'
       order by published_at desc limit 5`, [ev.entity, ev.seq ?? 0]);
    facts.priorPrints = prior;
  }
  return facts;
}

// ── generation ──────────────────────────────────────────────────────────────
const SYSTEM = [
  'You write short replies on X for Catalyst Pit, a market-intelligence product, underneath posts',
  'from a financial news account. You are a knowledgeable market participant adding ONE piece of',
  'information the original post did not contain.',
  '',
  'ABSOLUTE RULES:',
  '- Use ONLY the facts supplied in CONTEXT. Never introduce a number, date, company, ticker or',
  '  claim that is not there. If CONTEXT has nothing that adds to the post, return exactly: SKIP',
  '- Returning SKIP is the correct and expected answer most of the time. A weak reply is worse than',
  '  no reply. Do not stretch to produce one.',
  '- Never restate, summarise or paraphrase the original post.',
  '- No emojis. No hashtags. No em dashes or en dashes. No URLs. No questions.',
  '- No advice, no price targets, no predictions stated as fact.',
  '- Never name a news source, wire, publisher or where information came from.',
  '- Never mention Catalyst Pit or promote anything.',
  '- No filler openers: "Great point", "Interesting", "Worth watching", "Investors will be watching",',
  '  "This could impact", "Keep an eye on".',
  '',
  'STYLE: professional, factual, concise, trader to trader. 60 to 220 characters. One or two',
  'sentences. Plain declarative prose. State the fact and stop.',
  '',
  'Return ONLY the reply text, or exactly SKIP. No preamble, no quotes around it.',
].join('\n');

/**
 * Ask for a reply. Returns the text, or null when the model declines or the call fails.
 *
 * FAILURE IS ALWAYS A SKIP. A model error, a timeout, a refusal and a low-confidence answer all
 * produce no reply rather than a fallback, because a template reply is precisely the engagement
 * spam this engine exists to avoid.
 */
export async function generateReply(ev, facts, { apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) return { text: null, reason: 'no api key' };
  const post = String(ev.source_headline || ev.headline || '').slice(0, 900);
  const body = {
    model: MODEL,
    max_tokens: 300,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `ORIGINAL POST:\n${post}\n\nCONTEXT (the only facts you may use):\n${JSON.stringify(facts, null, 1).slice(0, 3500)}`,
    }],
  };
  try {
    const r = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { text: null, reason: `model HTTP ${r.status}` };
    const out = await r.json();
    const raw = String(out?.content?.[0]?.text ?? '').trim();
    if (!raw || /^SKIP\b/i.test(raw)) return { text: null, reason: 'model declined (nothing to add)' };
    return { text: raw.replace(/^["'`]+|["'`]+$/g, '').trim(), reason: null };
  } catch (e) {
    return { text: null, reason: `model error: ${String(e?.message || e).slice(0, 60)}` };
  }
}
