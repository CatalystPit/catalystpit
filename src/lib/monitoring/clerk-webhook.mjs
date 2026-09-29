import crypto from 'node:crypto';

// CLERK WEBHOOK SIGNATURE — Svix, verified without the SDK.
//
// Same decision as the Stripe webhook next door: the verification is twenty lines of HMAC and
// pulling in a signing library to do it would add a dependency to the one code path that must never
// be surprising. Keeping it here also makes it a pure function, so the cases that matter — a forged
// signature, a replayed delivery, a body altered after signing — are unit-testable without a network.
//
// ── ⚠️ THE THREE WAYS THIS DIFFERS FROM STRIPE'S SCHEME, each of which silently passes if you
//    assume they are the same:
//
// 1. THE SECRET IS BASE64, NOT THE LITERAL STRING. Clerk hands you `whsec_<base64>`; the HMAC key is
//    the DECODED bytes after that prefix, not the text. Using the string verifies nothing — every
//    signature fails, and the natural "fix" is to stop checking.
// 2. THE SIGNED PAYLOAD INCLUDES THE MESSAGE ID: `${svix-id}.${svix-timestamp}.${body}`. Stripe signs
//    `${t}.${body}`. Sign the wrong string and, again, everything fails closed.
// 3. THE HEADER CARRIES A SPACE-SEPARATED LIST of `v1,<sig>` pairs, because Svix supports rotating
//    to a new secret while the old one still verifies. Parsing only the first entry breaks every
//    rotation; ANY entry matching is a pass.
//
// The digest is base64, not hex.

/** Svix's own default, and the window a replayed delivery has to be useful in. */
export const CLERK_TOLERANCE_SEC = 300;

/**
 * Verify a Clerk (Svix) webhook signature.
 *
 * @param {string} payload  the RAW request body, exactly as received
 * @param {{id?:string,timestamp?:string,signature?:string}} h  the svix-id / svix-timestamp / svix-signature headers
 * @param {string} secret   CLERK_WEBHOOK_SIGNING_SECRET, the `whsec_...` value
 * @returns {boolean}
 */
export function verifyClerkSignature(payload, h, secret, nowSec = Math.floor(Date.now() / 1000), tolerance = CLERK_TOLERANCE_SEC) {
  const id = h?.id, timestamp = h?.timestamp, signature = h?.signature;
  if (!id || !timestamp || !signature || !secret) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // ⚠️ BOTH DIRECTIONS. A timestamp far in the future is as untrustworthy as one far in the past.
  if (tolerance > 0 && Math.abs(nowSec - ts) > tolerance) return false;

  let key;
  try {
    const raw = String(secret).startsWith('whsec_') ? String(secret).slice(6) : String(secret);
    key = Buffer.from(raw, 'base64');
  } catch { return false; }
  if (!key.length) return false;

  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64');
  const expectedBuf = Buffer.from(expected);

  // ⚠️ EVERY v1 ENTRY IS CHECKED, and a mismatch does NOT short-circuit the loop early in a way that
  // leaks which one matched — each comparison is constant-time and the result is OR-ed.
  let matched = false;
  for (const part of String(signature).split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    try {
      const given = Buffer.from(sig);
      if (given.length === expectedBuf.length && crypto.timingSafeEqual(given, expectedBuf)) matched = true;
    } catch { /* malformed entry is simply not a match */ }
  }
  return matched;
}

/**
 * How the account was created, from the Clerk user object — WITHOUT touching anything identifying.
 *
 * ⚠️ THIS READS PROVIDER NAMES, NEVER THE ACCOUNT. `external_accounts[].provider` is "oauth_google";
 * the same object also carries the email address, the name and the avatar URL, none of which we
 * store. Knowing that signups arrive via Google rather than email is the whole analytics question,
 * and it is answerable without keeping a single personal field.
 */
export function signupMethod(user) {
  const ext = Array.isArray(user?.external_accounts) ? user.external_accounts : [];
  const providers = [...new Set(ext.map((a) => String(a?.provider || '')).filter(Boolean))]
    .map((p) => p.replace(/^oauth_/, ''));
  if (providers.length) return providers.sort().join('+');
  return user?.password_enabled ? 'password' : 'other';
}
