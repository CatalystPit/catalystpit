import { auth, clerkClient } from '@clerk/nextjs/server';
import { publishPendingFacebook, publishFacebookTest, facebookStatus, queueRewordedFacebook,
  queueTrustedFacebook, facebookAuthHealth } from '../../../../lib/facebook-publisher';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Walter Bloomberg -> Catalyst Pit Facebook Page.
//
// Three actions, all behind the same authentication the other crons use:
//   (default)   drain the queue. Publishes nothing unless FACEBOOK_AUTO_POST_ENABLED is exactly
//               'true', so a scheduled call while the switch is off is a no-op.
//   ?status=1   report whether the Page id and token are configured. Never returns either.
//   ?test=1     publish ONE fixed test line to the Page. Deliberately bypasses the kill switch,
//               because its purpose is to prove the credentials work BEFORE automation is enabled;
//               the authentication below is what protects it.
//
// NO RESPONSE FROM THIS ROUTE EVER CONTAINS A TOKEN. facebookStatus() reports booleans, the
// publisher builds its failure strings from Meta's own error text, and nothing here reads
// process.env directly.
const CRON_SECRET = process.env.CRON_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

async function isAdmin() {
  try {
    const { userId } = await auth();
    if (!userId || !ADMIN_EMAIL) return false;
    const u = await (await clerkClient()).users.getUser(userId);
    const email = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress
      || u.emailAddresses[0]?.emailAddress;
    return !!email && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  } catch { return false; }
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  let authorized = isVercelCron || request.headers.get('authorization') === `Bearer ${CRON_SECRET}`;
  if (!authorized) authorized = await isAdmin();
  if (!authorized) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = new URL(request.url).searchParams;
  try {
    // Configuration readiness AND credential health. Booleans, counts and timestamps only.
    if (sp.get('status') === '1') {
      return Response.json({ ok: true, ...facebookStatus(), ...(await facebookAuthHealth()) });
    }
    if (sp.get('test') === '1') {
      const out = await publishFacebookTest();
      console.log(`[facebook] test post: ${out.sent ? 'sent ' + out.fbPostId : 'failed ' + out.reason}`);
      return Response.json({ ok: out.sent, ...out });
    }
    // Sources published in OUR words are queued HERE rather than at ingest, because at ingest the
    // rewrite does not exist yet. Queuing only; publishing is still the drain below, behind the same
    // kill switch. A failure here must never stop the drain, so it is reported and stepped over.
    let reworded = null;
    try { reworded = await queueRewordedFacebook(); }
    catch (e) {
      // Recorded where it can be READ. A swallowed error here is invisible otherwise: the drain
      // carries on, the run reports 200, and the only symptom is a source that never posts.
      reworded = { error: String(e?.message || e).slice(0, 200) };
      console.error('[facebook] reworded queue failed:', reworded.error);
      try {
        const { recordRewordedScanError } = await import('../../../../lib/facebook-publisher');
        await recordRewordedScanError(reworded.error);
      } catch { /* diagnostics must never fail the run */ }
    }

    // Events a TRUSTED source reported after another wire had already created them. Queued here for
    // the same reason as the reworded sources: at ingest the canonical event has no wording of ours
    // to publish yet. Failing here must never stop the drain either.
    let trusted = null;
    try { trusted = await queueTrustedFacebook(); }
    catch (e) {
      trusted = { error: String(e?.message || e).slice(0, 200) };
      console.error('[facebook] trusted-evidence queue failed:', trusted.error);
    }

    const res = await publishPendingFacebook();
    if (res.sent) console.log(`[facebook] published ${res.sent}`);
    // A CREDENTIAL OUTAGE MUST NOT LOOK LIKE A HEALTHY RUN. On 2026-09-16 a wrong-type token was
    // refused for 40 minutes while this route kept answering 200 OK, so nothing surfaced anywhere an
    // operator looks and every post queued in that window aged out and was lost. Answering 5xx is
    // what makes Vercel mark the cron run failed and notify.
    //
    // `results` is deliberately dropped: each entry carries Meta's own failure text, which is
    // credential-bearing (see redactCredential). Counts and timestamps are enough to act on.
    if (res.authFailures) {
      const { results, ...counts } = res;
      return Response.json({ ok: false, credentialAlarm: true, ...counts,
        ...(await facebookAuthHealth()) }, { status: 503 });
    }
    return Response.json({ ok: true, ...res, reworded, trusted });
  } catch (e) {
    // Meta's error text can be long; the message is capped and never carries a credential.
    return Response.json({ ok: false, error: String(e?.message || e).slice(0, 160) }, { status: 500 });
  }
}
