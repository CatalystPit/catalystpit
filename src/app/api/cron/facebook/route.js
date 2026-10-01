import { auth, clerkClient } from '@clerk/nextjs/server';
import { publishPendingFacebook, publishFacebookTest, facebookStatus, queueRewordedFacebook,
  queueTrustedFacebook, facebookAuthHealth } from '../../../../lib/facebook-publisher';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Walter Bloomberg -> Catalyst Pit Facebook Page, AND the social destinations that share this tick.
//
// ⚠️ WHY INSTAGRAM AND THREADS RUN HERE RATHER THAN ON THEIR OWN SCHEDULES. Vercel Pro allows 40 cron
// entries and this project uses all 40. A new destination therefore cannot have its own cron, and
// taking one from another production job to make room would trade a working feature for a new one.
// This route already runs every minute, is already the social publishing tick, and already carries the
// right authentication — so the new channels share it.
//
// SHARING A TICK IS NOT SHARING A FATE. Each destination has its own queue rows, its own dedupe
// identity, its own credential and its own health row, and each one's work here is wrapped so that a
// throw cannot reach another. Two orderings make that true rather than merely intended:
//
//   The new channels run BEFORE Facebook's credential alarm returns 503. A Facebook token outage must
//   not stop Instagram and Threads from publishing, and an early return would do exactly that.
//
//   Nothing a new channel does can change this route's STATUS CODE. The 503 means "the Facebook
//   credential is broken" and it has to keep meaning only that, because that is what Vercel's cron
//   alerting is wired to. A broken Instagram is visible in its own feed_state row and its own health
//   counts, and makes Facebook look exactly as healthy as it is.
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
      // ⚠️ ONE DESTINATION PER OBJECT, never merged. Flattening these would mean a single `ready` or
      // `credentialHealthy` standing for all of them, which is the shape that makes a broken Instagram
      // read as a broken Facebook — the precise thing this must not do.
      const social = {};
      for (const name of ['threads', 'instagram']) {
        try {
          const mod = name === 'threads'
            ? await import('../../../../lib/social/threads-publisher')
            : await import('../../../../lib/social/instagram-publisher');
          const { channelHealth } = await import('../../../../lib/social/social-store');
          social[name] = { ...(name === 'threads' ? mod.threadsStatus() : mod.instagramStatus()),
            ...(await channelHealth(name)) };
        } catch (e) { social[name] = { error: String(e?.message || e).slice(0, 160) }; }
      }
      return Response.json({ ok: true,
        facebook: { ...facebookStatus(), ...(await facebookAuthHealth()) },
        ...social,
        // Kept at the top level as well, unchanged, because existing checks read it from there.
        ...facebookStatus(), ...(await facebookAuthHealth()) });
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

    // ── THE OTHER DESTINATIONS, each fully isolated ───────────────────────────────────────────────
    // Imported here rather than at module scope so that a problem inside a new channel cannot prevent
    // this route from loading and draining Facebook. Each channel gets its own try/catch; a throw is
    // recorded where an operator reads feed health and then stepped over.
    const channels = {};
    for (const [name, run] of [
      ['threads', async () => {
        const { queueThreads, publishPendingThreads } = await import('../../../../lib/social/threads-publisher');
        const queued = await queueThreads();
        const drained = await publishPendingThreads();
        return { queued: queued.queued, examined: queued.examined, skipped: queued.skipped,
          sent: drained.sent, enabled: drained.enabled, configured: drained.configured ?? null,
          authFailures: drained.authFailures ?? 0 };
      }],
      ['instagram', async () => {
        const { queueInstagram, publishPendingInstagram } = await import('../../../../lib/social/instagram-publisher');
        const queued = await queueInstagram();
        const drained = await publishPendingInstagram();
        return { queued: queued.queued, examined: queued.examined, skipped: queued.skipped,
          sent: drained.sent, enabled: drained.enabled, configured: drained.configured ?? null,
          authFailures: drained.authFailures ?? 0 };
      }],
    ]) {
      try {
        channels[name] = await run();
        if (channels[name].sent) console.log(`[${name}] published ${channels[name].sent}`);
      } catch (e) {
        // The error text is OURS or a redacted provider message; it is capped and carries no credential.
        const why = String(e?.message || e).slice(0, 200);
        channels[name] = { error: why };
        console.error(`[${name}] tick failed:`, why);
        try {
          const { recordChannelScanError } = await import('../../../../lib/social/social-store');
          await recordChannelScanError(name, why);
        } catch { /* diagnostics must never fail the run */ }
      }
    }
    // A CREDENTIAL OUTAGE MUST NOT LOOK LIKE A HEALTHY RUN. On 2026-09-16 a wrong-type token was
    // refused for 40 minutes while this route kept answering 200 OK, so nothing surfaced anywhere an
    // operator looks and every post queued in that window aged out and was lost. Answering 5xx is
    // what makes Vercel mark the cron run failed and notify.
    //
    // `results` is deliberately dropped: each entry carries Meta's own failure text, which is
    // credential-bearing (see redactCredential). Counts and timestamps are enough to act on.
    if (res.authFailures) {
      const { results, ...counts } = res;
      // credentialAlarm is specifically ABOUT FACEBOOK. The other channels report beside it, so an
      // operator reading this response can see that they kept working while the Page token was broken.
      return Response.json({ ok: false, credentialAlarm: true, ...counts,
        ...(await facebookAuthHealth()), channels }, { status: 503 });
    }
    return Response.json({ ok: true, ...res, reworded, trusted, channels });
  } catch (e) {
    // Meta's error text can be long; the message is capped and never carries a credential.
    return Response.json({ ok: false, error: String(e?.message || e).slice(0, 160) }, { status: 500 });
  }
}
