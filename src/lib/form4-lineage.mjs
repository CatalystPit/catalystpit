// FORM 4/A → THE FILING IT AMENDS. Pure: candidates in, a decision out. No database, no network.
//
// ── ⚠️ A FORM 4/A ALMOST NEVER NAMES THE ACCESSION IT AMENDS ────────────────
//
// Measured across all 901 distinct 4/A filings in our corpus: exactly ONE states the accession it
// amends, and it does so in free prose a filer chose to write — NYAX 0001976408-26-000547, whose
// <remarks> read "This Form 4/A is an amendment for Accession number: 0001976408-26-000518". The
// other 900 carry no accession-shaped string anywhere: not in the header, not in <remarks>, not in
// a footnote. Their prose says "the original Form 4, filed on August 24, 2026" — narrative for a
// human, not a key. There is NO schema element for it, which is why one filer writing it by hand is
// the exception that proves the rule.
//
// THIS IS WHY THE PARSER PRODUCED NOTHING. lib/form4.mjs read `<accessionNumber>` — an element that
// does not exist in the Form 4 ownership schema at all — so `amends_accession` was null on every
// amendment we have ever stored. It was not a gap in coverage; it was a field that was never there.
//
// ── WHAT THE FILING DOES GIVE ───────────────────────────────────────────────
//
//     <dateOfOriginalSubmission>2026-08-24</dateOfOriginalSubmission>
//
// alongside <issuerCik>, <periodOfReport> and one <rptOwnerCik> per reporting owner. That is the
// SEC's own structured statement of when the amended filing was submitted, and it is authoritative
// filing metadata rather than an inference about matching transactions.
//
// ── THE THREE STATES, AND WHY THERE IS NO FUZZY ONE ─────────────────────────
//
// EXPLICIT       the source names the original accession outright AND we hold that filing for the
//                same issuer. Rare — one filing in 901 — and the corroboration is not ceremony: the
//                reference is hand-typed prose, so an uncorroborated one is a typo we would be
//                writing into the lineage as fact.
// DETERMINISTIC  exactly ONE filing in our corpus matches the filing metadata the amendment states:
//                same issuer, same reporting owner, filed on the date the amendment gives as its
//                original submission. Not the period — see the note at the match itself.
// UNRESOLVED     no candidate, or more than one. This is a correct outcome, not a failure.
//
// ⚠️ NOTHING HERE LOOKS AT TRANSACTIONS. Not shares, not price, not code, not "the filings are two
// days apart". Two filings matching on those fields is a coincidence this rule must never promote
// to a lineage claim — a false edge silently rewrites the evidence engine's view of a company,
// while a missing edge is visible debt.

export const LINK_BASIS = Object.freeze({
  EXPLICIT: 'EXPLICIT',
  DETERMINISTIC: 'DETERMINISTIC',
  UNRESOLVED: 'UNRESOLVED',
});

const one = (xml, tag) => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(String(xml || ''));
  return m ? m[1].trim() : null;
};
const many = (xml, tag) => [...String(xml || '').matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'gi'))]
  .map((m) => m[1].trim()).filter(Boolean);
const cik = (v) => (v == null ? null : String(v).replace(/^0+/, '') || '0');
/**
 * ⚠️ NINE FILINGS IN THE CORPUS STATE A DATE WITH A TIMEZONE OFFSET WELDED ON: two filer agents
 * emit `<dateOfOriginalSubmission>2025-02-19-05:00</dateOfOriginalSubmission>`, and the same for
 * <periodOfReport>. Postgres rejects that outright, and a string compare against a clean date would
 * silently never match — so every date entering this module is cut back to its calendar day. The
 * offset carries no information here: a filing's submission date is a date, not an instant.
 */
export const filingDay = (v) => {
  const s = String(v ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const day = filingDay;

/** The lineage facts a Form 4/A states about itself. */
export function amendmentSource(xml) {
  const documentType = one(xml, 'documentType') || '';
  return {
    documentType,
    isAmendment: documentType.endsWith('/A'),
    periodOfReport: day(one(xml, 'periodOfReport')),
    origSubmissionDate: day(one(xml, 'dateOfOriginalSubmission')),
    issuerCik: cik(one(xml, 'issuerCik')),
    ownerCiks: [...new Set(many(xml, 'rptOwnerCik').map(cik))],
    // Recorded so a link can be audited against the filing's own words later.
    remarks: (/<remarks>([\s\S]*?)<\/remarks>/i.exec(String(xml || ''))?.[1] || '')
      .replace(/\s+/g, ' ').trim().slice(0, 500) || null,
    // Proof per filing that no accession reference existed to prefer over the date.
    accessionRefs: [...new Set([...String(xml || '').matchAll(/\b\d{10}-\d{2}-\d{6}\b/g)].map((m) => m[0]))],
  };
}

/**
 * Resolve which candidate filing an amendment amends.
 *
 * @param src         from amendmentSource()
 * @param candidates  every NON-amendment filing we hold for this issuer, as
 *                    { accession, issuerCik, ownerCik, filingDate, periodOfReport }
 * @param self        this amendment's own accession, so it can never link to itself
 * @returns {{ accession: string|null, basis: string, reason: string }}
 */
export function resolveAmendment(src, candidates, self = null) {
  if (!src?.isAmendment) return { accession: null, basis: LINK_BASIS.UNRESOLVED, reason: 'not-an-amendment' };

  // Everything we hold for this issuer, indexed once — used both to corroborate a stated accession
  // and to run the date rule. Cross-issuer candidates are dropped here, so neither path can reach one.
  // ⚠️ ONE FILING, MANY REPORTING OWNERS. A joint Form 4 arrives as several candidate rows sharing
  // an accession, so the owners are collected into a set per accession — keeping only the first row
  // would miss an amendment filed by the second owner on a joint filing.
  const held = new Map();
  for (const c of candidates || []) {
    if (!c || !c.accession || c.accession === self) continue;            // never itself
    if (cik(c.issuerCik) !== src.issuerCik) continue;                    // never across issuers
    const prior = held.get(c.accession);
    if (prior) { prior.owners.add(cik(c.ownerCik)); continue; }
    held.set(c.accession, {
      filingDate: c.filingDate, periodOfReport: c.periodOfReport, owners: new Set([cik(c.ownerCik)]),
    });
  }

  // ⚠️ IF THE FILING NAMES AN ACCESSION, THAT WINS — PROVIDED WE HOLD IT. No schema element carries
  // this; the one filing in 901 that states it typed it into <remarks> by hand. So a stated
  // reference is corroborated against our own corpus before it becomes a link, and a reference we
  // cannot corroborate stops the resolution rather than falling through to the date rule: the filer
  // has told us which filing this amends, and quietly linking a DIFFERENT one because the dates line
  // up would be us overruling the source.
  const named = [...new Set((src.accessionRefs || []).filter((a) => a !== self))];
  if (named.length === 1 && held.has(named[0])) {
    return {
      accession: named[0],
      basis: LINK_BASIS.EXPLICIT,
      reason: `accession stated in the filing and held for issuer ${src.issuerCik}`,
    };
  }
  if (named.length) {
    return {
      accession: null,
      basis: LINK_BASIS.UNRESOLVED,
      reason: named.length > 1 ? 'the filing names more than one accession'
        : 'the filing names an accession we do not hold for this issuer',
    };
  }

  if (!src.origSubmissionDate) {
    return { accession: null, basis: LINK_BASIS.UNRESOLVED, reason: 'no dateOfOriginalSubmission' };
  }

  const owners = new Set(src.ownerCiks || []);
  const hits = [];
  for (const [accession, c] of held) {
    if (owners.size && ![...c.owners].some((o) => owners.has(o))) continue;  // the same reporting owner
    if (day(c.filingDate) !== src.origSubmissionDate) continue;          // filed when the SEC says
    // ⚠️ THE PERIOD IS DELIBERATELY NOT MATCHED ON. An earlier version required it and lost 90
    // genuine links. Correcting the date of earliest transaction is one of the commonest reasons to
    // file a 4/A at all — PG's says "amended solely to correct the date of the stock sale", CTAS's
    // says "discrepancy in date of earliest transaction" — so the amendment's period is precisely
    // the field it came to change, and demanding it equal the original's rejects the true filing.
    // Nothing is loosened by dropping it: the decision still rests on issuer, reporting owner and
    // the SEC's own stated submission date, and still requires EXACTLY ONE filing to fit. Measured
    // over the corpus, dropping it changed ZERO existing links, gained 90, and turned 6 into
    // UNRESOLVED — which is the correct answer when two filings genuinely fit.
    hits.push(accession);
  }

  if (hits.length === 1) {
    return {
      accession: hits[0],
      basis: LINK_BASIS.DETERMINISTIC,
      reason: `sole filing by owner ${[...owners].join('/')} for issuer ${src.issuerCik} `
        + `filed ${src.origSubmissionDate}`,
    };
  }
  return {
    accession: null,
    basis: LINK_BASIS.UNRESOLVED,
    reason: hits.length === 0 ? 'no candidate filing matches the stated metadata'
      : `${hits.length} candidates match; the filing does not say which`,
  };
}

/**
 * Collapse a set of edges into the CURRENT authoritative accession for each filing.
 *
 * ⚠️ A CHAIN IS NORMAL: an original, then an amendment, then an amendment of the amendment. The
 * authoritative version is the newest filing in the chain, and every earlier member points at it —
 * not at its immediate successor — so a consumer reading superseded_by never has to walk a list.
 *
 * Guards, because a bad edge here is worse than no edge: a filing can never supersede itself, and a
 * cycle is dropped entirely rather than resolved arbitrarily.
 *
 * @param edges [{ amendment, amends }] newest-last is not assumed; order is derived from `filedAt`
 * @param filedAt Map(accession -> ISO date) used only to pick the newest member of a chain
 * @returns Map(accession -> authoritative accession) for every superseded filing
 */
export function resolveChains(edges, filedAt = new Map()) {
  // ⚠️ TWO AMENDMENTS OF THE SAME FILING SUPERSEDE EACH OTHER, NOT JUST THE ORIGINAL. An earlier
  // version kept the newer of the two and simply dropped the older edge — which left the older
  // amendment marked as superseding nothing and superseded by nothing, so it went on counting
  // alongside the newer one. That is the double count this whole exercise exists to prevent, and it
  // hit 11 originals in the corpus. A 4/A is the operative complete filing for its report, so the
  // newest filing in the group is authoritative and BOTH the original and the older amendments
  // point at it. That is filing order, not a guess about content.
  const claims = new Map();        // original -> [amendments claiming it]
  for (const e of edges || []) {
    if (!e?.amendment || !e?.amends || e.amendment === e.amends) continue;
    if (!claims.has(e.amends)) claims.set(e.amends, []);
    if (!claims.get(e.amends).includes(e.amendment)) claims.get(e.amends).push(e.amendment);
  }
  const at = (a) => Date.parse(filedAt.get(a) || '') || 0;
  const next = new Map();          // superseded filing -> the filing that supersedes it
  for (const [orig, amds] of claims) {
    // Newest wins; an identical timestamp falls back to accession order so the result is stable
    // rather than dependent on the order the edges arrived in.
    const sorted = [...amds].sort((a, b) => at(b) - at(a) || (a < b ? 1 : -1));
    const head = sorted[0];
    next.set(orig, head);
    for (const older of sorted.slice(1)) next.set(older, head);
  }

  const out = new Map();
  for (const start of next.keys()) {
    let cur = start;
    const walked = new Set([start]);
    let cycle = false;
    while (next.has(cur)) {
      const n = next.get(cur);
      if (walked.has(n)) { cycle = true; break; }
      walked.add(n);
      cur = n;
    }
    if (cycle || cur === start) continue;
    out.set(start, cur);
  }
  return out;
}
