// ── WHAT THE FEAR & GREED INDEX PUBLISHES, AND WHAT IT WITHHOLDS ───────────
//
// ⚠️ EXTRACTED FROM /api/fear-greed BECAUSE app/fear-greed/page.jsx RENDERS THE SCORE NOW, AND THIS
// IS A DISCLOSURE BOUNDARY RATHER THAN A SHAPE.
//
// The route does not simply return the stored payload. It strips the window length, the refusal
// threshold and the methodology version — "most of the recipe stated as integers", plus an
// identifier that means nothing to a reader while telling anyone reproducing us exactly which
// revision they are looking at. It also drops each component's `samples`, which is the
// normalisation window wearing a different name, and the withdrawn non-inclusion disclosure while
// its feature flag is off.
//
// Every one of those was a defect once, and one of them was caught against the LIVE RESPONSE
// rather than the source: the version travels as a field on the methodology object as well as on
// the payload, so removing it from one and serving the other put it straight back.
//
// A second copy of that stripping, written to let a server component render the gauge, is the same
// defect waiting a third time — and this time it would be baked into cached public HTML. So there
// is one function, both callers use it, and verify-rooms-ssr asserts the route no longer strips
// anything itself.
import { readPayload, payloadFromHistory } from './store.mjs';
import { METHODOLOGY, COMPONENTS, ZONES } from './model.mjs';
import { featureEnabled } from '../feature-availability.mjs';

/**
 * The index exactly as a reader may see it, or the honest unavailable state.
 *
 * ⚠️ FAIL CLOSED. No stored index is "we do not know" — never a 50 and never a guess. The
 * unavailable branch serves the SAME stripped methodology as the success path, because it was once
 * the one response a reader sees when something is wrong and it leaked the identifier.
 *
 * @returns {Promise<object>} `{ available: false, reason, methodology, zones }` or the full payload
 */
export async function fearGreedPublicPayload() {
  let payload = await readPayload();
  let source = 'kv';
  if (!payload) {
    payload = await payloadFromHistory();
    source = 'history';
  }

  const methodology = publicMethodology();

  if (!payload) {
    return { available: false, reason: 'not-yet-computed', methodology, zones: ZONES };
  }

  // ⚠️ LABELS COME FROM THE LIVE REGISTRY, NOT FROM THE CACHED PAYLOAD. buildPayload bakes each
  // component's wording in at build time, so a rename would keep serving the old words until the
  // next daily cron — up to 24 hours of the UI calling Realized Volatility "Market Volatility".
  // The scores stay exactly as computed; only the words are re-read.
  //
  // ⚠️ AND A COMPONENT THE CURRENT METHODOLOGY NO LONGER HAS MUST NOT BE SERVED. A stored payload
  // from an older version can carry one; the registry is the definition of what the index is.
  const meta = new Map(COMPONENTS.map((m) => [m.key, m]));
  const components = (payload.components || [])
    .filter((c) => meta.has(c.key))
    .map(({ samples, ...c }) => {
      void samples;
      return { ...c, label: meta.get(c.key).label, meaning: meta.get(c.key).meaning };
    });

  const { version, normalizationWindow, minComponents, ...rest } = payload;
  void version; void normalizationWindow; void minComponents;

  return { ...rest, components, source, zones: ZONES, methodology, componentMeta: COMPONENTS };
}

/**
 * The methodology with the recipe taken out.
 *
 * ⚠️ INCLUDING THE VERSION INSIDE IT. That field is why this is a function and not a constant.
 */
function publicMethodology() {
  const { version, ...rest } = METHODOLOGY;
  void version;
  // ⚠️ THE NON-INCLUSION DISCLOSURE, WHILE IT IS SWITCHED OFF. The page already does not render it,
  // but serving it anyway ships four paragraphs of withdrawn disclosure to every reader in the
  // JSON — visible to anyone reading the response, and the kind of thing that gets quoted back as
  // though it were published. One flag governs both ends so a restore is a single change; the text
  // itself stays in METHODOLOGY.excluded.
  if (!featureEnabled('fearGreedExclusions')) delete rest.excluded;
  return rest;
}
