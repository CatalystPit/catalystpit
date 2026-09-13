// Anti-hallucination grounding validators.
//
// EXTRACTED VERBATIM from src/app/api/bulls-bears/route.js (commit d8dfe56, lines 227-340). The
// function bodies below are byte-identical to the originals; the ONLY edits are added `export`
// keywords. Behavioural equivalence against the pre-extraction implementations is proven by
// scripts/verify-grounding.mjs, which runs both versions over a shared corpus plus randomized
// inputs and requires every result to match exactly.
//
// These are the gate every LLM-generated string in Catalyst Pit must pass: a claimed number must
// trace to a real source value, a claimed proper noun must appear in the sources, and a cited
// source category must be one we actually supplied. Used by bulls/bears synthesis and by the
// external-news headline writer.

// ── VALIDATION (anti-hallucination, defense-in-depth) ──────────────────────────
// Parse every numeric token in a string into actual VALUES (handling $, %, commas, and
// T/B/M/K magnitude suffixes). Value-based + tolerant matching fixes the magnitude problem
// (model "$124.3B" vs source raw "124300000000") and rounding (model "37.4x" vs source 37.36)
// that pure string-matching silently false-dropped.
export function valuesIn(text) {
  const out = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(t|b|m|k)?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const base = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(base)) continue;
    const s = (m[2] || '').toLowerCase();
    const mult = s === 't' ? 1e12 : s === 'b' ? 1e9 : s === 'm' ? 1e6 : s === 'k' ? 1e3 : 1;
    out.push(base * mult);
    if (mult !== 1) out.push(base);   // also allow the bare form to match
  }
  return out;
}

// Numbers a bullet ASSERTS as financial facts — after removing things that aren't claims:
// ISO dates, standalone 4-digit years, ratio constructs (X:1), and small standalone counts.
export function claimNumbers(text) {
  let t = String(text || '');
  t = t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');                  // ISO dates
  t = t.replace(/\b(?:19|20)\d{2}\b/g, ' ');                     // standalone years ("since 1945")
  t = t.replace(/\b\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\b/g, ' ');  // ratios ("24.6:1") — analytical, not raw stats
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(t|b|m|k)?/gi;
  const claims = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const raw = m[0].trim();
    const base = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(base)) continue;
    const s = (m[2] || '').toLowerCase();
    // ignore small standalone integers (bullet counts: "5 analysts", "3 insiders", "10 times")
    if (!s && Number.isInteger(base) && base <= 12) continue;
    const mult = s === 't' ? 1e12 : s === 'b' ? 1e9 : s === 'm' ? 1e6 : s === 'k' ? 1e3 : 1;
    claims.push({ raw, value: base * mult });
  }
  return claims;
}

// a claimed value is "traced" if some source value is within 1% (or a tiny absolute epsilon).
export function traced(value, hayValues) {
  const tol = Math.max(Math.abs(value) * 0.01, 0.01);
  return hayValues.some((hv) => Math.abs(hv - value) <= tol);
}

// Generic market/macro capitalized terms that are vocabulary, NOT data claims to verify.
export const GENERIC_CAPS = new Set([
  'wall street', 'federal reserve', 'the fed', 'main street', 'big tech', 's&p', 'dow jones',
  'new york', 'united states', 'silicon valley', 'free cash', 'price target',
]);
// Real source categories. If a bullet cites one of these but we didn't pass it → fabricated source.
export const KNOWN_CATEGORIES = new Set(['10-Q', '10-K', '8-K', 'Form 4', 'FINRA', 'Congress', 'News', 'Market data']);

// Multi-word proper nouns a bullet references (person/org names, publishers). Strips a leading
// article so "The Vision Pro" → "Vision Pro". Used to catch fabricated names not in the sources.
export function nameClaims(text) {
  const out = [];
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    let cand = m[1].replace(/^(The|This|These|That|A|An|Its|Their|Our)\s+/i, '').trim();
    if (cand.split(/\s+/).length >= 2) out.push(cand);
  }
  return out;
}

// Role/title words a bullet prepends to a name ("Director Arthur Levinson", "CFO Luca Maestri")
// or generic descriptors — NOT part of the name, so excluded before token matching.
export const NAME_NOISE = new Set([
  'the', 'this', 'these', 'that', 'a', 'an', 'its', 'their', 'our',
  'director', 'ceo', 'cfo', 'coo', 'cto', 'president', 'chief', 'executive', 'officer',
  'svp', 'evp', 'vp', 'senior', 'vice', 'general', 'counsel', 'chairman', 'chairwoman',
  'chair', 'founder', 'cofounder', 'treasurer', 'secretary', 'representative', 'senator',
  'congressman', 'congresswoman', 'analyst', 'inc', 'corp', 'co', 'ltd', 'plc',
]);

// Significant tokens of a name: lowercased, role/article words removed, initials (<3 chars)
// dropped. "Director Arthur D. Levinson" → ['arthur','levinson'] so order/format/middle-initial
// differences vs the source feed ("LEVINSON ARTHUR D") don't cause false drops.
export function nameTokens(name) {
  return String(name).toLowerCase().replace(/[.'']/g, '').split(/\s+/)
    .filter((w) => w.length >= 3 && !NAME_NOISE.has(w));
}

// Validate one bullet. Returns { ok, reason }: reason ∈ 'number' | 'name' | 'source' when dropped.
export function validateBullet(b, companyName, hayValues, hayLower, allowedSources) {
  const text = String(b?.text || '');
  // 1) fabricated SOURCE: cites a known category we never provided (e.g. "8-K" when we passed none)
  const src = String(b?.source || '').trim();
  if (src && KNOWN_CATEGORIES.has(src) && !allowedSources.has(src)) return { ok: false, reason: 'source', detail: src };
  // 2) fabricated NUMBER: a claimed financial value that traces to no source value
  for (const c of claimNumbers(text)) {
    if (!traced(c.value, hayValues)) return { ok: false, reason: 'number', detail: c.raw };
  }
  // 3) fabricated NAME: a multi-word proper noun whose significant tokens are not ALL present
  // as whole words in the sources. Token-subset (not substring) so "Director Arthur Levinson"
  // traces to source "LEVINSON ARTHUR D" (order/format/initial differences ignored), while a
  // fabricated surname still fails because its token is absent from the source word set.
  const companyTokens = new Set(nameTokens(companyName || ''));
  const hayWords = new Set(hayLower.match(/[a-z]{3,}/g) || []);
  for (const nm of nameClaims(text)) {
    if (GENERIC_CAPS.has(nm.toLowerCase())) continue;
    const toks = nameTokens(nm);
    if (!toks.length) continue;
    if (toks.every((t) => companyTokens.has(t))) continue;
    if (toks.every((t) => hayWords.has(t))) continue;
    return { ok: false, reason: 'name', detail: nm };
  }
  return { ok: true };
}
