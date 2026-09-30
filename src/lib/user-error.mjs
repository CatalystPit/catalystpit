// A REFUSAL THE USER IS MEANT TO READ, distinguished from a failure they are not.
//
// ⚠️ WHY THIS EXISTS. Every alert route ended its handlers with `catch (e) => { error: e.message }`,
// which conflates two completely different things:
//
//   "limit of 200 alerts reached"        — the user's own action, refused for a reason they can act
//                                          on. The client displays this string verbatim.
//   'relation "evidence_alerts" ...'     — our database failing. The user can do nothing with it,
//                                          it names our internals, and reporting it as a 400 tells
//                                          the caller they sent something wrong when they did not.
//
// Marking the first kind is what lets a route return the message for a refusal and an opaque code
// for a failure, without an allowlist of message strings that silently rots as the messages change.

/** A refusal whose message is written FOR the user and may be returned to them. */
export function userError(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

/** True only for a refusal raised deliberately by our own validation. */
export const isUserError = (e) => e?.userFacing === true;

/**
 * The body and status for one caught exception.
 *
 * ⚠️ THE DEFAULT IS THE SAFE ONE. Anything not explicitly marked is treated as our failure: 503,
 * no detail. A new throw added later is opaque until someone decides it should not be.
 */
export function errorResponse(e, code) {
  return isUserError(e)
    ? { body: { error: e.message }, status: 400 }
    : { body: { error: code }, status: 503 };
}
