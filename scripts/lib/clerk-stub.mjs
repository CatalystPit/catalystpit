// Stands in for @clerk/nextjs/server so a verification script can execute the REAL entitlement
// module. The identity is settable per case, because what is under test is how entitlements.js turns
// an identity into a tier — not Clerk itself.
//
// ⚠️ THE SHAPE MUST MATCH WHAT THE REAL MODULE READS, or the test measures the stub. A first version
// used `publicMetadata.tier` and reported that a Pro account resolved to free; the real key is
// `publicMetadata.plan`, stamped by the Stripe webhook, with `publicMetadata.beta === true` as a
// separate manual flag and ADMIN_EMAIL as a third path. Modelled here exactly:
//
//   plan 'pro' | 'elite'   -> that tier, beta false
//   beta === true          -> { tier: 'pro', beta: true }   (Pro features, delayed data)
//   primary email === ADMIN_EMAIL -> { tier: 'elite', beta: false }
//   anything else          -> free
//
// ⚠️ AND IT CAN FAIL ON DEMAND, because "fails closed" is a behaviour, not a string. Two optional
// flags make the identity provider break the way it really breaks:
//
//   authThrows: true     -> auth() throws, so the caller's own catch is what must deny
//   getUserThrows: true  -> auth() succeeds and the user lookup throws, so resolveUserAccess's catch is
//
// Both default off, so every existing case is unaffected. Without these, a fail-closed assertion can
// only match the source text of a catch block — which passes whether or not the catch actually denies.
let current = { userId: null, publicMetadata: {}, email: null, authThrows: false, getUserThrows: false };

export function __setIdentity(next) {
  current = { userId: null, publicMetadata: {}, email: null, authThrows: false, getUserThrows: false, ...next };
}

export async function auth() {
  if (current.authThrows) throw new Error('clerk unavailable');
  return { userId: current.userId };
}

export const clerkClient = async () => ({
  users: {
    getUser: async () => {
      if (current.getUserThrows) throw new Error('clerk user lookup failed');
      return {
        publicMetadata: current.publicMetadata || {},
        privateMetadata: {},
        primaryEmailAddressId: 'e1',
        emailAddresses: current.email ? [{ id: 'e1', emailAddress: current.email }] : [],
      };
    },
  },
});
