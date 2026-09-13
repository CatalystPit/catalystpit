// Catalyst Pit original headline generation + factual extraction, with a hard anti-fabrication gate.
//
// The model does exactly two things: restate the event in Catalyst Pit's voice, and extract the
// factual skeleton. It does NOT set importance, category or tickers — those stay deterministic and
// auditable, because they drive ranking and a model that can quietly promote a routine item is a
// model that can distort the product.
//
// FAIL CLOSED. A generated headline that cannot be traced back to the source text is discarded and
// the source's own headline is kept instead (headline_status='source_fallback'). An unvalidated
// generated headline is never published — the fallback is always a real sentence a real source
// actually wrote.
//
// SEC never reaches this file. See runEnrichment() in primary-events.js.

import { valuesIn, validateBullet } from './grounding.mjs';
import { validatePredicate } from './predicate-grounding.mjs';

export const MODEL = 'claude-haiku-4-5-20251001';   // same model the rest of the app uses
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const BATCH_SIZE = 15;
export const MAX_HEADLINE = 90;

// House voice: state what happened. These are the words that editorialise a fact into a take, and
// none of them can be traced to a source, because they are judgements rather than claims.
const HYPE = /\b(soars?|soaring|plunges?|plunging|crushes?|crushing|skyrockets?|tanks?|explodes?|slams?|stuns?|shocking|massive|huge|incredible|disaster|catastroph\w*|boom|bombshell|meltdown|epic|insane|jaw-dropping|must-(see|read|buy)|guaranteed|surefire)\b/i;

// Symbol-shaped tokens the headline asserts. Used to stop the model naming a ticker we did not
// conservatively resolve.
const TICKER_TOKEN = /\$([A-Z]{1,5})\b|\(([A-Z]{1,5}):|\b([A-Z]{2,5})\b(?=\s+(?:shares|stock|rose|fell|jumped|dropped))/g;

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ── prompt ───────────────────────────────────────────────────────────────────
const SYSTEM = [
  'You rewrite financial news headlines for Catalyst Pit, a market-intelligence product.',
  '',
  'For each numbered item you receive, return an ORIGINAL headline and the factual skeleton.',
  '',
  'HEADLINE RULES:',
  `- At most ${MAX_HEADLINE} characters. One line. No trailing period.`,
  '- State only what the source states. Never add context, cause, consequence or market reaction.',
  '- Never invent a number, name, date, company or ticker. If the source does not say it, it does not exist.',
  '- Do not copy the source headline word-for-word; restate the same fact in plain, factual language.',
  '- No hype verbs (soars, plunges, crushes), no adjectives of judgement, no clickbait, no questions.',
  '- Do not add a ticker symbol. Tickers are attached separately.',
  '- Lead with the actor when there is one: "Pfizer wins FDA clearance for ..." not "FDA clears ...".',
  '',
  'FACTS RULES:',
  '- actor: who did it (company/agency), exactly as named in the source, or null.',
  '- action: the verb of what happened, lowercase, or null.',
  '- object: what it was done to, or null.',
  '- value: any headline figure exactly as written in the source (e.g. "$1.2B", "25 basis points"), or null.',
  '- effective_date: a date the source states, ISO if given, else null.',
  '- Every value must appear in the source text. Use null rather than guessing. null is always acceptable.',
  '',
  'Return ONLY a JSON array, no prose, no code fences:',
  '[{"i":0,"headline":"...","facts":{"actor":null,"action":null,"object":null,"value":null,"effective_date":null}}]',
].join('\n');

export function buildUserMessage(items) {
  return items.map((it, i) => {
    const parts = [`[${i}] SOURCE: ${it.source_name || it.source}`, `HEADLINE: ${it.source_headline || it.headline}`];
    if (it.summary) parts.push(`SUMMARY: ${String(it.summary).slice(0, 700)}`);
    return parts.join('\n');
  }).join('\n\n');
}

const stripFences = (s) => String(s || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

// ── validation ───────────────────────────────────────────────────────────────
// `sourceText` is everything the source actually said for this item. Nothing outside it is real.
export function validateHeadline(candidate, sourceText, allowedTickers = []) {
  const h = String(candidate || '').trim().replace(/\s+/g, ' ');
  if (!h) return { ok: false, reason: 'empty' };
  if (h.length > MAX_HEADLINE) return { ok: false, reason: 'too_long', detail: String(h.length) };
  if (/\n/.test(h)) return { ok: false, reason: 'multiline' };
  if (HYPE.test(h)) return { ok: false, reason: 'hype', detail: (h.match(HYPE) || [])[0] };

  // Verbatim copy is not an original headline. Near-overlap is fine and often unavoidable for a
  // short factual statement; an exact reproduction is not.
  const src = String(sourceText || '');
  const srcHead = src.split('\n')[0].replace(/^HEADLINE:\s*/i, '');
  if (squash(h) === squash(srcHead)) return { ok: false, reason: 'verbatim_copy' };

  // A ticker the resolver did not confirm must not appear.
  const allowed = new Set(allowedTickers.map((t) => String(t).toUpperCase()));
  for (const m of h.matchAll(TICKER_TOKEN)) {
    const sym = (m[1] || m[2] || m[3] || '').toUpperCase();
    if (sym && !allowed.has(sym)) return { ok: false, reason: 'unresolved_ticker', detail: sym };
  }

  // The shared grounding gate: every claimed number must trace to a source value, every claimed
  // proper noun must appear in the source. Identical logic to bulls/bears (proven in
  // scripts/verify-grounding.mjs), so both surfaces enforce one standard.
  const v = validateBullet({ text: h, source: '' }, '', valuesIn(src), src.toLowerCase(), new Set());
  if (!v.ok) return v;

  // Nouns and numbers are not the whole sentence. This checks what the rewrite ASSERTS: a reversed
  // direction ("raises" -> "cuts"), a swapped event type ("guidance" -> "bankruptcy") or an added
  // reason the source never gave all invent a fact while using only real names and real figures.
  const p = validatePredicate(h, src);
  if (!p.ok) return p;
  return { ok: true };
}

// Facts are stored only where each field is traceable. An untraceable field becomes null rather
// than blocking the item: a partial skeleton is useful, an invented one is not.
export function validateFacts(facts, sourceText) {
  if (!facts || typeof facts !== 'object') return null;
  const src = String(sourceText || '');
  const hay = src.toLowerCase();
  const hayValues = valuesIn(src);
  const out = {};
  for (const k of ['actor', 'action', 'object', 'value', 'effective_date']) {
    const raw = facts[k];
    if (raw == null || raw === '') { out[k] = null; continue; }
    const s = String(raw).trim();
    const v = validateBullet({ text: s, source: '' }, '', hayValues, hay, new Set());
    if (!v.ok) { out[k] = null; continue; }
    // Free-text fields must also actually occur in the source, token-wise.
    const toks = squash(s).split(' ').filter((w) => w.length >= 3);
    out[k] = toks.length && !toks.every((t) => hay.includes(t)) ? null : s;
  }
  return out;
}

// ── model call ───────────────────────────────────────────────────────────────
// Returns { results, available }. `available: false` means the MODEL never spoke — no key, no
// credits, HTTP error, timeout, rate limit, unparseable response. That is an infrastructure outage,
// not a judgement about the item, so the caller must not spend the item's retry budget on it.
// `available: true` with a missing entry means the model genuinely returned nothing for that row.
export async function generateBatch(items, { apiKey = process.env.ANTHROPIC_API_KEY, signal } = {}) {
  const out = new Map();
  const unavailable = (error) => ({ results: out, available: false, error });
  if (!apiKey) return unavailable('no ANTHROPIC_API_KEY');
  if (!items.length) return { results: out, available: true };

  let text = '';
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        temperature: 0.2,               // low temp → fewer confabulations, same as bulls/bears
        system: SYSTEM,
        messages: [
          { role: 'user', content: buildUserMessage(items) },
          { role: 'assistant', content: '[' },   // prefill: forces a bare JSON array
        ],
      }),
    });
    if (!r.ok) return unavailable('HTTP ' + r.status);
    const data = await r.json();
    text = '[' + (data?.content?.[0]?.text || '');
  } catch (e) { return unavailable(String(e?.message || e).slice(0, 80)); }

  let parsed;
  try { parsed = JSON.parse(stripFences(text)); } catch { return unavailable('unparseable response'); }
  if (!Array.isArray(parsed)) return unavailable('unexpected response shape');

  for (const row of parsed) {
    const i = Number(row?.i);
    if (!Number.isInteger(i) || i < 0 || i >= items.length) continue;
    out.set(i, { headline: String(row.headline || '').trim(), facts: row.facts ?? null });
  }
  return { results: out, available: true };
}
