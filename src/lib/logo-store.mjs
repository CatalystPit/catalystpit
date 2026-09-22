// THE SIGNATURE STORE. Minimal Upstash REST, same hand-rolled shape as api-guard's limiter —
// deliberately not imported from the consensus materialization helpers, which belong to a
// subsystem this has no business coupling to.
//
// ⚠️ EVERY FUNCTION HERE FAILS OPEN AND SILENT. This store decides whether a picture is shown; it
// must never decide whether a PAGE is shown. A KV outage returns nulls, every ticker classifies
// UNKNOWN, and the map renders exactly as it did before any of this existed.

import { createHash } from 'node:crypto';
import { sigKey, famKey, SIG_TTL_SEC } from './logo-identity.mjs';

/**
 * Content hash of the image bytes — the signal the whole mechanism rests on.
 *
 * ⚠️ IT LIVES HERE, NOT IN logo-identity.mjs, BECAUSE THAT MODULE IS IMPORTED BY A CLIENT
 * COMPONENT. Hashing needs node:crypto; putting it beside the classification pulled node:crypto
 * into the Holding Map's browser bundle and broke the build. Server work with the server work.
 *
 * Truncated to 16 hex chars (~64 bits) — far beyond what is needed to tell a few thousand logos
 * apart, and it keeps the KV keys short.
 */
export function logoSignature(buf) {
  if (!buf) return null;
  return createHash('sha256').update(Buffer.from(buf)).digest('hex').slice(0, 16);
}

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
export const logoStoreConfigured = () => Boolean(KV_URL && KV_TOKEN);

async function kv(path) {
  if (!logoStoreConfigured()) return null;
  try {
    const r = await fetch(`${KV_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: 'no-store',
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const enc = encodeURIComponent;

/**
 * Record that `ticker` resolved to image content `sig` ('none' when the provider had no logo).
 *
 * Two writes: the ticker's own signature, and the ticker's membership of that signature's set.
 * The set is what makes the family measurable — SCARD of it is the "how many distinct securities
 * wear this same picture" number, maintained incrementally rather than recomputed.
 */
export async function recordLogoSignature(ticker, sig) {
  if (!ticker || !sig) return;
  await kv(`/set/${enc(sigKey(ticker))}/${enc(sig)}?EX=${SIG_TTL_SEC}`);
  if (sig === 'none') return;                       // no image, so no family to join
  await kv(`/sadd/${enc(famKey(sig))}/${enc(String(ticker).toUpperCase())}`);
  await kv(`/expire/${enc(famKey(sig))}/${SIG_TTL_SEC}`);
}

/** The stored signature for a ticker, or null if we have never measured it. */
export async function readLogoSignature(ticker) {
  const r = await kv(`/get/${enc(sigKey(ticker))}`);
  return r?.result ?? null;
}

/** How many DISTINCT tickers are known to share this image. */
export async function countSignatureMembers(sig) {
  if (!sig || sig === 'none') return 0;
  const r = await kv(`/scard/${enc(famKey(sig))}`);
  const n = Number(r?.result);
  return Number.isFinite(n) ? n : 0;
}
