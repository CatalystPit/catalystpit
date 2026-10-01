import { resolveGoRequest } from '../../../lib/affiliates/go-request.mjs';
import { recordAffiliateClick } from '../../../lib/affiliates/affiliate-clicks.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /go/<partner>?placement=<id> → 302 to a destination this server already knew.
//
// ⚠️ WHY A REDIRECT AT ALL, RATHER THAN A DIRECT href. Three concrete reasons, none of them "redirects
// are tidy":
//
//   THE AFFILIATE URL STOPS BEING PUBLIC BUNDLE CONTENT. The strip previously read
//   NEXT_PUBLIC_AFF_TRADINGVIEW and friends, and a NEXT_PUBLIC_ variable is compiled into the JavaScript
//   every visitor downloads. An affiliate id is not a secret, but it also has no business being
//   immutable build output: changing one meant a rebuild and a redeploy.
//
//   IT MAKES PII LEAKAGE STRUCTURALLY IMPOSSIBLE RATHER THAN MERELY ABSENT. Building the outbound URL in
//   a client component puts it in a scope where the signed-in user's state is one variable away. Here
//   there is no user state in scope at all — this function never calls auth(), never reads a cookie and
//   never touches a session, so there is nothing available to leak even by accident.
//
//   IT IS THE ONLY PLACE A CLICK CAN BE COUNTED WITHOUT A TRACKING SCRIPT. A 302 happens before any
//   JavaScript runs, so a client analytics beacon cannot observe it; the server already can.
//
// ⚠️ WHY IT IS NOT AN OPEN REDIRECT, stated plainly: NO URL FROM THE REQUEST IS EVER USED. The only input
// is a partner KEY matched against a server-side registry by exact equality. There is no `?url=`, no
// `?to=`, no `?next=` and no code path that reads one. The scheme, hostname and credential checks in
// partners.mjs guard against a CONFIGURATION mistake, not against a visitor — a visitor has no way to
// express a destination here at all. That is also why this cannot become a URL shortener: it can only
// name things committed to the repository.
//
// ⚠️ AND IT IS NOT CLOAKING. The link text says where it goes, the disclosure renders beside it, the
// redirect is a plain 302 any user or crawler can follow, and the destination is the partner's real URL.
// Nothing here shows one thing to a person and another to a network.
//
// THE DECISIONS ARE IN go-request.mjs, which is pure and unit-tested against encoded `javascript:` URLs,
// spoofed hostnames and protocol-relative strings. This file is the I/O: parse, count, answer.

/** 404 with a body that says nothing. A probe must not learn which partner keys exist. */
const refuse = (headers) => new Response('Not found', { status: 404, headers });

export async function GET(request) {
  const decision = resolveGoRequest({ url: request.url });

  if (decision.status !== 302) return refuse(decision.headers);

  // ⚠️ AWAITED, NOT FIRED AND FORGOTTEN. A serverless function can be frozen the instant its response is
  // returned, which drops an un-awaited insert. recordAffiliateClick swallows its own failures, so this
  // cannot cost the reader their click — our interest in counting it is strictly secondary to their
  // having asked to go somewhere.
  await recordAffiliateClick(decision.partnerKey, decision.placement ?? 'unknown');

  // 302, not 301 and not 307. Temporary is the honest description: a partner can be disabled tomorrow.
  // A 301 would be cached indefinitely by browsers and could not be withdrawn. 307 exists to preserve
  // the request method, which matters for POST and is irrelevant to a link.
  //
  // ⚠️ IT WORKS WITHOUT JAVASCRIPT, which is the other reason it is a real redirect rather than a page
  // with a script in it: the Location header is the whole mechanism.
  return new Response(null, { status: 302, headers: decision.headers });
}

// ⚠️ NO OTHER METHOD IS ANSWERED. A link is a GET. Leaving POST and the rest to Next's default 405 means
// this endpoint cannot be used as a generic forwarder for anything carrying a body.
