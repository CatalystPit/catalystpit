// THE ONE PLACE AN AFFILIATE PARTNER IS DEFINED. Pure: no database, no network, no React, no secrets
// written down. Everything that varies between environments arrives through `env`.
//
// ⚠️ THERE ARE ZERO PARTNERS. The registry below is EMPTY on purpose, and that is the deliverable: the
// machinery exists, configured and tested, and contains no invented relationship. Adding one later is a
// single entry here plus one environment variable — not a code change scattered through components.
//
// ⚠️ NO DATABASE TABLE FOR THE PARTNERS THEMSELVES. At zero partners, and realistically at a dozen, a
// table buys nothing a reviewed file does not: partners change by deliberate decision, not by user
// action, so the change wants a diff, a review and a deploy rather than an admin form. The click
// RECORD is a different matter and does have a table — see affiliate-clicks.js, and the note there
// about why Vercel Web Analytics could not do that job.
//
// WHY A PARTNER DECLARES ITS OWN HOST. `url` comes from the environment, which means a typo, a paste
// error or a stale value can point it anywhere. `allowedHost` is the partner's assertion about where
// its link is supposed to go, checked at resolution time, so a misconfigured variable fails closed
// instead of silently redirecting Catalyst Pit's traffic to whatever the variable now says.

/**
 * Where an affiliate placement may appear. A placement id is part of the system's vocabulary: it names
 * a surface, is validated before use, and is the only thing ever passed outward as a sub-id.
 *
 * ⚠️ THIS LIST IS SHORT BECAUSE THE DENY LIST IS LONG. Research surfaces are absent by design, not by
 * omission — see FORBIDDEN_PLACEMENT_SURFACES, which is asserted by the test suite rather than left as
 * a convention somebody has to remember.
 */
export const PLACEMENTS = Object.freeze({
  TICKER_OVERVIEW: 'ticker_overview',
});

export const PLACEMENT_IDS = Object.freeze(Object.values(PLACEMENTS));

/**
 * Surfaces that must never carry an affiliate placement, named so a test can enforce it.
 *
 * These are the places where a monetized link would either compete with research the user came for, or
 * be mistaken for part of it. The sign-up and checkout entries are there for a different reason: a
 * commercial distraction in a conversion flow costs more than it earns, and an affiliate CTA beside a
 * payment form is the shape of a dark pattern.
 */
export const FORBIDDEN_PLACEMENT_SURFACES = Object.freeze([
  'insiders', 'politicians', 'institutions', 'consensus', 'terminal', 'screener', 'scan',
  'news', 'watchlist', 'charts', 'evidence', 'sign-up', 'sign-in', 'account', 'checkout',
]);

/**
 * THE REGISTRY. Empty until a real relationship exists.
 *
 * Shape of an entry, for when one is added:
 *
 *   key           stable identifier; appears in the /go path and in click records. Lowercase,
 *                 [a-z0-9-], because it becomes part of a URL.
 *   name          display name, shown to the user.
 *   label         the sentence on the card. Describes the product, never recommends it.
 *   cta           button text.
 *   envVar        name of the SERVER-side variable holding the full affiliate URL. Never NEXT_PUBLIC_:
 *                 the URL does not reach the browser at all under the /go design.
 *   allowedHost   the exact hostname the affiliate URL must have, or an array of them. A configured
 *                 URL pointing anywhere else is refused.
 *   fallbackUrl   OPTIONAL, and only ever the ordinary non-affiliate destination for the same product.
 *                 Used when the affiliate URL is absent or refused. Omit it and the CTA disappears
 *                 instead — which is the correct default, because a destination we did not state is a
 *                 destination we must not invent.
 *   subIdParam    OPTIONAL. The query parameter the network uses for a sub-id, if it supports one.
 *                 Only a validated placement id is ever sent as its value.
 *   placements    the placement ids this partner may appear in. An empty array means nowhere.
 *   enabled       explicit. A partner is off until someone writes true.
 *   disclosure    'affiliate' — the only value, and required. It exists as a field so that a future
 *                 entry cannot be added without the author confronting it.
 */
export const PARTNERS = Object.freeze([
  // ⚠️ DO NOT ADD A PARTNER HERE TO MAKE A TEST PASS. The suite builds its own synthetic fixtures and
  // never reads this array for examples; an entry here is a statement that a real commercial
  // relationship exists. At the time of writing there are none.
]);

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** Hostnames that are never a legitimate affiliate destination, whatever a variable says. */
const isForbiddenHost = (host) => {
  const h = String(host || '').toLowerCase();
  if (!h || !h.includes('.')) return true;                       // bare names, localhost
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'catalystpit.com' || h.endsWith('.catalystpit.com')) return true;  // not an outbound link
  // Literal addresses, including the loopback and the private and link-local ranges. A hostname is
  // compared as text here on purpose: the point is to refuse an address-shaped destination outright,
  // not to resolve it.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^\[?[0-9a-f:]*:[0-9a-f:]*\]?$/i.test(h)) return true;      // any IPv6 literal
  return false;
};

/**
 * Is a configured affiliate URL safe to redirect to?
 *
 * ⚠️ EVERY CHECK HERE IS ABOUT A VALUE WE CONFIGURED, NOT ABOUT USER INPUT. No URL from a request ever
 * reaches this function — that is what makes an open redirect impossible rather than merely unlikely.
 * These checks exist because configuration is also a place mistakes live: a pasted `javascript:` string,
 * a protocol-relative `//evil.test` that looks like a path, an http:// link that would downgrade the
 * user, credentials left in the URL from a copied example.
 */
export function validateAffiliateUrl(raw, allowedHost) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: 'no url configured' };
  // A protocol-relative URL resolves against the current page and is a classic way for something that
  // reads as a path to become a different origin. Refused before parsing, because `new URL` with a base
  // would happily accept it.
  if (s.startsWith('//')) return { ok: false, reason: 'protocol-relative url' };
  let u;
  try { u = new URL(s); } catch { return { ok: false, reason: 'unparseable url' }; }
  // https only. http would be a downgrade on every click, and anything else — javascript:, data:,
  // file:, vbscript: — is refused by the same rule rather than by a blacklist that has to stay complete.
  if (u.protocol !== 'https:') return { ok: false, reason: `scheme ${u.protocol} is not https` };
  if (u.username || u.password) return { ok: false, reason: 'url carries credentials' };
  if (isForbiddenHost(u.hostname)) return { ok: false, reason: `host ${u.hostname} is not a valid destination` };
  if (!allowedHost) return { ok: false, reason: 'partner declares no allowed host' };
  const allowed = (Array.isArray(allowedHost) ? allowedHost : [allowedHost]).map((h) => String(h).toLowerCase());
  const host = u.hostname.toLowerCase();
  // ⚠️ EXACT MATCH, OR A DOT-ANCHORED SUBDOMAIN. `endsWith(allowed)` alone would accept
  // `evil-example.com` for `example.com`, and `example.com.evil.test` for the same — the two classic
  // hostname-spoofing shapes. Requiring either equality or a literal '.' before the allowed suffix
  // rejects both.
  const hostOk = allowed.some((a) => host === a || host.endsWith(`.${a}`));
  if (!hostOk) return { ok: false, reason: `host ${host} is not among the partner's allowed hosts` };
  return { ok: true, url: u };
}

/**
 * Look a partner up by key. Unknown keys are not an error worth distinguishing from a disabled one.
 *
 * ⚠️ THE `list` PARAMETER IS A TEST SEAM AND NOTHING ELSE. Production always passes the real registry,
 * which is empty; the suite passes synthetic fixtures. Without it, testing the disabled-partner branch,
 * the hostname-spoofing branch or the sub-id branch would require writing an invented partner into
 * PARTNERS, and an entry there is a statement that a commercial relationship exists.
 */
export const findPartner = (key, list = PARTNERS) =>
  list.find((p) => p.key === String(key || '')) || null;

/**
 * Resolve a partner to something linkable, or refuse with a reason.
 *
 * ⚠️ THE FAIL-SAFE CONTRACT, AND IT HAS EXACTLY THREE OUTCOMES:
 *
 *   { ok: true,  url, kind: 'affiliate' }  the configured affiliate URL, validated.
 *   { ok: true,  url, kind: 'plain' }      the partner's OWN ordinary destination, when it declared one.
 *   { ok: false, reason }                  nothing is linkable, so the caller shows nothing.
 *
 * What it will never do: manufacture a destination, fall back to another partner, guess a URL from a
 * name, or return a URL it could not validate. A missing configuration makes a CTA disappear; it does
 * not make a different CTA appear.
 */
export function resolvePartner(key, { env = process.env, placement = null, partners = PARTNERS } = {}) {
  const p = findPartner(key, partners);
  if (!p) return { ok: false, reason: 'unknown partner' };
  if (!KEY_RE.test(p.key)) return { ok: false, reason: 'malformed partner key' };
  if (p.enabled !== true) return { ok: false, reason: 'partner disabled' };
  if (placement != null && !isEligiblePlacement(p, placement)) {
    return { ok: false, reason: 'partner not eligible for this placement' };
  }
  if (p.disclosure !== 'affiliate') return { ok: false, reason: 'partner declares no disclosure' };

  const configured = p.envVar ? env[p.envVar] : null;
  const v = validateAffiliateUrl(configured, p.allowedHost);
  if (v.ok) {
    const url = withSubId(v.url, p, placement);
    return { ok: true, url: url.toString(), kind: 'affiliate', partner: p, reason: null };
  }

  // ⚠️ THE FALLBACK IS THE PARTNER'S OWN PLAIN URL AND NOTHING ELSE. It is used only when the partner
  // explicitly declared one, and it is validated by the same rules — a fallback is still a destination
  // we are sending a reader to.
  if (p.fallbackUrl) {
    const f = validateAffiliateUrl(p.fallbackUrl, p.allowedHost);
    if (f.ok) return { ok: true, url: f.url.toString(), kind: 'plain', partner: p, reason: v.reason };
  }
  return { ok: false, reason: v.reason };
}

/** Whether a partner may appear in a placement. An unknown placement id is never eligible. */
export function isEligiblePlacement(partner, placement) {
  if (!partner || !Array.isArray(partner.placements)) return false;
  if (!PLACEMENT_IDS.includes(placement)) return false;
  return partner.placements.includes(placement);
}

/**
 * Attach the sub-id, if the partner supports one.
 *
 * ⚠️ THE ONLY THING WE EVER SEND IS A PLACEMENT ID — a fixed word from our own vocabulary, validated
 * against PLACEMENT_IDS before it gets here. Not a user id, not a session, not a ticker, not a hash of
 * anything. A sub-id is for telling 'which surface earned this', and a surface is not a person.
 *
 * It is set with `searchParams.set`, which replaces rather than appends, so a value already present in
 * the configured URL cannot be duplicated, and it is encoded by URLSearchParams, so a param name or
 * value cannot inject another parameter.
 */
export function withSubId(url, partner, placement) {
  const out = new URL(url.toString());
  if (!partner?.subIdParam) return out;
  if (!PLACEMENT_IDS.includes(placement)) return out;
  out.searchParams.set(String(partner.subIdParam), placement);
  return out;
}

/**
 * Every partner that may render in a placement right now, as the CLIENT needs to see it.
 *
 * ⚠️ NO URL IS INCLUDED, and that is the point of the shape. The browser receives a key, a label and a
 * call to action; the destination lives on the server and is reached through /go. So an affiliate id
 * never enters the client bundle, never appears in `view-source`, and changing one does not require a
 * client rebuild.
 */
export function placementOffers(placement, { env = process.env, partners = PARTNERS } = {}) {
  if (!PLACEMENT_IDS.includes(placement)) return [];
  return partners
    .filter((p) => isEligiblePlacement(p, placement))
    .map((p) => ({ p, r: resolvePartner(p.key, { env, placement, partners }) }))
    .filter(({ r }) => r.ok)
    .map(({ p }) => ({ key: p.key, name: p.name, label: p.label, cta: p.cta }));
}

/** The disclosure sentence shown wherever a monetized link renders. One string, one place. */
export const AFFILIATE_DISCLOSURE =
  'Some links are affiliate links · CatalystPit may earn a commission at no cost to you. Not financial advice.';

/**
 * The rel attribute for a monetized outbound link.
 *
 * `sponsored` is what Google asks for on a paid or commissioned link; `nofollow` is kept alongside it
 * because it is the older signal and costs nothing to send. `noopener noreferrer` is unrelated to SEO —
 * it stops the opened page reaching back through window.opener, and keeps our URL out of the
 * destination's referrer log.
 *
 * ⚠️ THIS IS FOR MONETIZED LINKS ONLY. Ordinary editorial and source citations — the 37 outbound links
 * already in the product — keep plain `noopener noreferrer`. Blanket-nofollowing real citations throws
 * away the one honest signal the site sends about where its facts come from.
 */
export const MONETIZED_REL = 'nofollow sponsored noopener noreferrer';
export const EDITORIAL_REL = 'noopener noreferrer';
