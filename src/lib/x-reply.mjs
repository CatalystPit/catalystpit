// CATALYST PIT X AUTO-REPLY — eligibility, grounding and validation.
//
// PURE. No database, no network, no environment. The caller supplies the event and the internal
// facts it gathered; this decides whether a reply is warranted and whether a generated one may be
// published. Keeping it pure is what lets the dry run exercise exactly the code production runs.
//
// THE GOVERNING RULE IS THAT NO REPLY BEATS A WEAK REPLY. A reply under someone else's post carries
// our name on their timeline. A generic reaction, an obvious summary or a restatement of what they
// just said is worse than silence: it reads as a bot, and it is the fastest way to make the account
// look automated. So every gate here fails closed, and "we have nothing to add" is a correct,
// expected, frequent outcome.

// Only accounts we have explicitly approved. One entry for now, by instruction.
export const REPLY_WHITELIST = new Set(['WALTERBLOOMBERG']);

export const MIN_REPLY_CHARS = 60;
export const TARGET_MAX_CHARS = 220;
// Hard ceiling, well under X's 280 so a trailing cashtag or a stray space can never overflow.
export const HARD_MAX_CHARS = 250;

// ── style bans ───────────────────────────────────────────────────────────────
// Phrases that say nothing. Each one is the signature of an engagement bot, and a reply containing
// any of them adds no information by construction.
const ENGAGEMENT = [
  /\bgreat (point|call|post|thread)\b/i, /\b(very |really |quite )?interesting\b/i,
  /\bthanks for sharing\b/i, /\bgood (catch|point|call)\b/i, /\bwell said\b/i,
  /\bthis is (big|huge|important|key)\b/i, /\bexactly\b/i, /\bspot on\b/i,
  /\bcould impact\b/i, /\bwill be watching\b/i, /\binvestors (will|should) be watching\b/i,
  /\bworth watching\b/i, /\bone to watch\b/i, /\bkeep an eye on\b/i,
  /\bstay tuned\b/i, /\bmore to come\b/i, /\btime will tell\b/i,
  /\bwhat do you think\b/i, /\bthoughts\?/i,
  /\bcatalyst ?pit\b/i, /\bcheck out\b/i, /\bfollow us\b/i, /\bour (platform|site|app)\b/i,
];

// Advice and prediction. We report facts; we do not tell anyone what to do or assert the future.
const ADVICE = [
  /\b(buy|sell|short|long) (the|this|it|now|here)\b/i, /\bshould (buy|sell|own|avoid)\b/i,
  /\bprice target\b/i, /\bwill (hit|reach|rally|crash|fall|rise) to\b/i,
  /\bexpect(ing)? (a|the)? ?\d/i, /\bguaranteed\b/i, /\bwe (like|prefer|recommend)\b/i,
];

// House style, already enforced everywhere else in the product.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
const HASHTAG = /(^|\s)#\w/;
const EM_DASH = /[—–]/;
const URL = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|co)\b/i;
// Anything that names where a fact came from. The whole product claim is that Pit Wire presents one
// canonical event without saying which feed found it, and a reply is the most public surface we have.
// A bare "per" is not attribution: "$50 per ounce" is a unit. Measured — it rejected a perfectly
// good gold reply on the dry run. Attribution is "per <a source>", so the word has to be followed by
// something that names one.
const ATTRIBUTION = /\b(according to|per (a |the )?(report|sources?|filing by|statement)|sources? (say|said|told)|reuters|bloomberg|globenewswire|prnewswire|newsfile|seeking ?alpha|zerohedge|financialjuice|telegram|t\.me|walter)\b/i;

// ── what a post has to be before a reply is even considered ─────────────────
// A daily agenda, a link roundup or a multi-item digest is not an event. Walter posts these every
// session; they carry a dozen times and figures none of which is the subject, and any reply to one
// is necessarily generic.
const ROUNDUP = [
  /\bwhat to watch\b/i, /\bweek ahead\b/i, /\bday ahead\b/i, /\bmorning (brief|wrap|note)\b/i,
  /\brecap\b/i, /\bhere (are|is) the\b/i, /\bkey events\b/i,
];
const isRoundup = (text) => {
  const s = String(text || '');
  if (ROUNDUP.some((re) => re.test(s))) return true;
  // Several clock times in one post is an agenda whatever it calls itself.
  const times = s.match(/\b\d{1,2}:\d{2}\s?(?:AM|PM)?\b/gi) || [];
  return times.length >= 3;
};

// A quoted official saying something is not, by itself, a fact we can extend. "KREMLIN: X IS A GOOD
// IDEA" is an opinion attributed to a speaker; we hold no data that bears on it, so anything we add
// would be commentary rather than information.
const SPEAKER_QUOTE = /^[A-Z][A-Z\s.'&-]{2,28}:\s/;
const OPINION = /\b(thinks?|believes?|hopes?|wants?|calls for|welcomed?|good idea|should be|is a|are a)\b/i;

/**
 * Should Catalyst Pit even consider replying to this post?
 *
 * `ev` is the canonical event; `facts` is whatever internal context the caller could gather. Returns
 * { eligible, reason } — reason is always populated so a skip is auditable.
 */
export function replyEligibility(ev, facts = {}) {
  const no = (reason) => ({ eligible: false, reason });
  if (!ev) return no('no event');
  if (!REPLY_WHITELIST.has(String(ev.source || '').toUpperCase())) return no('source not whitelisted');
  // THE HARD REQUIREMENT. A reply needs the X post to reply to. A Catalyst Pit event id is not one,
  // and replying to a guess would put our name under a stranger's post.
  if (!ev.x_post_id) return no('no original X post id for this post');

  const text = String(ev.source_headline || ev.headline || '');
  if (text.length < 25) return no('post too short to carry a fact');
  if (isRoundup(text)) return no('agenda or roundup, not a single event');
  if (SPEAKER_QUOTE.test(text) && OPINION.test(text)) return no('attributed opinion, nothing factual to extend');

  // Something we actually hold data about. Either a ticker we resolved, or a figure the post itself
  // states that our own records can put in context.
  const tickers = (ev.tickers || []).filter(Boolean);
  const hasTickerContext = tickers.length > 0 && (
    facts.lastClose || facts.insider?.length || facts.congress?.length
    || facts.priorEvents?.length || facts.filings?.length);
  const hasSeriesContext = !!facts.priorPrints?.length;
  if (!hasTickerContext && !hasSeriesContext) return no('no internal facts to add');

  return { eligible: true, reason: null };
}

// ── validation of a generated reply ─────────────────────────────────────────
const NUMBER = /\d[\d,]*\.?\d*\s?(?:%|percent|bps|basis points|billion|bn|million|mn|trillion|tn|k\b)?/gi;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.%]+/g, ' ');

/** Every numeric token in `text`, normalised for comparison against the facts we hold. */
export function numbersIn(text) {
  return [...String(text || '').matchAll(NUMBER)]
    .map((m) => m[0].trim().toLowerCase().replace(/[,\s]/g, ''))
    .filter((x) => x && /\d/.test(x) && x.length > 1);
}

/**
 * May this reply be published?
 *
 * `evidence` is the concatenation of everything we actually know: the post's own words plus the
 * internal facts the caller gathered. A number that is not in there was invented by the model, and
 * an invented number on a public reply is the single worst failure available here.
 */
export function validateReply(text, ev, facts = {}, recent = []) {
  const no = (reason) => ({ valid: false, reason });
  const s = String(text || '').trim();
  if (!s) return no('empty');
  if (s.length < MIN_REPLY_CHARS) return no(`too short (${s.length} < ${MIN_REPLY_CHARS})`);
  if (s.length > HARD_MAX_CHARS) return no(`too long (${s.length} > ${HARD_MAX_CHARS})`);

  if (EMOJI.test(s)) return no('contains an emoji');
  if (HASHTAG.test(s)) return no('contains a hashtag');
  if (EM_DASH.test(s)) return no('contains an em dash');
  if (URL.test(s)) return no('contains a URL');
  if (ATTRIBUTION.test(s)) return no('names a source');
  if (/\?\s*$/.test(s)) return no('ends in a question');
  for (const re of ENGAGEMENT) if (re.test(s)) return no('generic engagement wording');
  for (const re of ADVICE) if (re.test(s)) return no('advice or prediction');

  // Restating the post back is the most common bot failure and adds nothing.
  const post = norm(ev?.source_headline || ev?.headline || '');
  const reply = norm(s);
  const postWords = new Set(post.split(' ').filter((w) => w.length > 4));
  const replyWords = reply.split(' ').filter((w) => w.length > 4);
  const overlap = replyWords.length
    ? replyWords.filter((w) => postWords.has(w)).length / replyWords.length : 0;
  // 0.6, not 0.7: a near-verbatim restatement measured exactly 70% on the dry run and slipped
  // through. The threshold has to sit below what a restatement actually scores.
  if (overlap > 0.6) return no(`restates the post (${Math.round(overlap * 100)}% word overlap)`);

  // Cashtags must be tickers we resolved for THIS event, and must be shaped like tickers.
  const allowed = new Set((ev?.tickers || []).map((t) => String(t).toUpperCase()));
  for (const m of s.matchAll(/\$([A-Za-z.\-]{1,10})\b/g)) {
    const sym = m[1].toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,6}$/.test(sym)) return no(`malformed cashtag $${m[1]}`);
    if (!allowed.has(sym)) return no(`unsupported ticker $${sym}`);
  }

  // GROUNDING. Every number must already exist in the post or in the facts we gathered.
  const evidence = [ev?.source_headline, ev?.headline, JSON.stringify(facts)].join(' ');
  const known = new Set(numbersIn(evidence));
  const bare = (x) => x.replace(/[^0-9.]/g, '');
  const knownBare = new Set([...known].map(bare));
  for (const nmb of numbersIn(s)) {
    if (known.has(nmb) || knownBare.has(bare(nmb))) continue;
    return no(`ungrounded number "${nmb}"`);
  }

  // Do not repeat ourselves across recent replies.
  for (const prev of recent || []) {
    const p = norm(prev);
    const pw = new Set(p.split(' ').filter((w) => w.length > 4));
    const rw = reply.split(' ').filter((w) => w.length > 4);
    const ov = rw.length ? rw.filter((w) => pw.has(w)).length / rw.length : 0;
    if (ov > 0.6) return no('too close to a recent reply');
  }

  return { valid: true, reason: null };
}

// ── rate control ────────────────────────────────────────────────────────────
/** Configuration, read from the environment so the kill switch needs no deployment. */
export function replyConfig(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    // MASTER KILL SWITCH. Anything other than the exact string 'true' disables replies, so an
    // unset, misspelled or empty variable fails closed rather than open.
    enabled: String(env.X_AUTO_REPLY_ENABLED ?? '') === 'true',
    walterEnabled: String(env.X_AUTO_REPLY_WALTER_ENABLED ?? '') === 'true',
    minIntervalMs: num(env.X_AUTO_REPLY_MIN_INTERVAL, 300) * 1000,   // 5 minutes
    dailyCap: num(env.X_AUTO_REPLY_DAILY_CAP, 20),
  };
}

/**
 * Gate a batch of eligible candidates on cooldown and daily cap.
 *
 * When several posts arrive inside one cooldown window, the highest-value one is chosen rather than
 * the first — a cooldown that always replies to whatever landed first would systematically pick the
 * least considered opportunity.
 */
export function selectForReply(candidates, { lastReplyAt, sentToday, config, now = Date.now() }) {
  if (!config.enabled) return { pick: null, reason: 'X_AUTO_REPLY_ENABLED is not true' };
  if (!config.walterEnabled) return { pick: null, reason: 'Walter replies not enabled' };
  if (sentToday >= config.dailyCap) return { pick: null, reason: `daily cap reached (${config.dailyCap})` };
  if (lastReplyAt && now - new Date(lastReplyAt).getTime() < config.minIntervalMs) {
    return { pick: null, reason: 'within cooldown' };
  }
  const ranked = [...(candidates || [])].sort((a, b) =>
    (b.importance ?? 0) - (a.importance ?? 0)
    || (b.tickers?.length ?? 0) - (a.tickers?.length ?? 0)
    || new Date(b.published_at) - new Date(a.published_at));
  return ranked.length ? { pick: ranked[0], reason: null } : { pick: null, reason: 'no eligible candidate' };
}
