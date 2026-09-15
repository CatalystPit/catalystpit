// Issuer-name normalisation, shared by every path that turns a 13F issuer STRING into an identity.
//
// It lives on its own because three consumers must agree exactly or the pipeline undoes the repair:
// the live resolver (name-resolver.js), the historical repair (scripts/repair-cross-issuer.mjs) and
// the regression suite. Two spellings of the same rule is how the defect this fixes got in.
//
// THE DEFECT. A 13F issuer string names the ISSUER of the security, and for a fund that issuer is the
// sponsor's trust, not the sponsor. The old matcher accepted a match when either condensed core was a
// PREFIX of the other, and a sponsor's name is a prefix of every product it sponsors, so
// "INVESCO EXCH TRADED FD TR II" matched the registrant "Invesco Ltd." and 33 unrelated Invesco
// securities landed on IVZ. The same shape put ProShares' trust on AGQ, Innovator's on INHD and the
// BlackRock closed-end municipal trusts on BLK.
//
// THE RULE. Cores must be EQUAL. Equality is still tolerant of how a filer writes a name, because
// corporate suffixes and security descriptors are dropped before comparing — "ALPHABET INC CAP STK
// CL A" and "Alphabet Inc." both reduce to ALPHABET — but a different ENTITY can no longer reduce to
// a shorter one: EXCH, TRADED and FD are not droppable words, so INVESCOEXCHTRADEDFDTR never equals
// INVESCO.

// Corporate form and structure words. Dropping these is what lets one issuer be written many ways.
const CORPORATE = ['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'COMPANIES', 'LTD',
  'LIMITED', 'PLC', 'LLC', 'LLP', 'LP', 'NV', 'SA', 'SE', 'AG', 'THE', 'HOLDINGS', 'HOLDING', 'HLDGS',
  'HLDG', 'HLDNGS', 'HLDNG', 'PL', 'GROUP', 'GRP', 'TECHNOLOGIES', 'TECHNOLOGY', 'TECH'];

// Words that describe the SECURITY rather than name the issuer. A 13F filer may put any of these in
// the issuer field ("ALPHABET INC CAP STK CL A"), so they are dropped — but every one of them is a
// generic instrument word. None of them is part of an entity's name, which is why dropping them
// cannot merge two different issuers the way the old prefix rule did.
// STK, SHS, REG, REGISTERED and VOTING are added to the vocabulary this inherited. Each names a
// SHARE TYPE and nothing else, so dropping them merges only spellings of one issuer: measured over
// the 17,790 issuer prefixes in production they collapse 21 pairs, and every one is a company's own
// dual listing — TELUS 002381 with 87971M, Deutsche Telekom, Logitech, Exor, Aker BP, BYD.
//
// CAPITAL, VALUE, INTEREST, SERIES and PAR are deliberately NOT here even though filers do write them
// as descriptors. The same measurement showed they collapse DIFFERENT issuers onto bare cores like
// INTERNATIONAL and ALLIED — Capital International reducing to INTERNATIONAL is the same failure as
// Invesco Ltd swallowing Invesco's trusts, reached from the other side. A word earns a place here
// only if it cannot be part of an entity's name.
//
// COM is the closest call and is also left out. It is the commonest class token in a 13F and dropping
// it would correctly unify CARS COM INC with CARS (832 rows that currently resolve to nothing), but
// it also merges GOLD COM INC into U S GOLD CORP — two different issuers on one core. The unification
// is worth having and the merge is not, so this is recorded as a follow-up rather than guessed at
// here: it needs the issuer field split from the class field, not another word in a list.
const DESCRIPTOR = ['COMMON', 'STOCK', 'STK', 'SHARES', 'SHARE', 'SHS', 'CLASS', 'CL', 'ADR', 'ADS',
  'SPONSORED', 'SPON', 'SPONSORD', 'ORD', 'ORDINARY', 'NEW', 'PUT', 'CALL', 'OPT', 'OPTION',
  'WARRANT', 'WT', 'WTS', 'RIGHTS', 'UNIT', 'UNITS', 'EACH', 'REPRESENTING', 'REPSTG',
  'REG', 'REGISTERED', 'VOTING'];

// Kept for the one legacy caller that read it; the two halves are the vocabulary above.
export const STOP = new Set([...CORPORATE, ...DESCRIPTOR, 'SWITZ', 'SWITZERLAND']);

/**
 * Condensed core of an issuer name: CDATA and punctuation stripped, corporate-form and
 * security-descriptor words dropped, single characters dropped, the rest joined with no separator.
 * "BLACKROCK INC" and "BlackRock, Inc." -> BLACKROCK.  "BLACKROCK MUN INC TRUST II" -> BLACKROCKMUNTRUSTII.
 */
export const ncore = (s) => String(s || '')
  .toUpperCase()
  .replace(/<!\[CDATA\[|\]\]>/g, ' ')
  .replace(/&AMP;|&/g, ' AND ')
  .replace(/[^A-Z0-9 ]/g, ' ')
  .split(/\s+/)
  .filter((t) => t && t.length > 1 && !STOP.has(t))
  .join('');

/** A name that describes a bond, note or preferred rather than an equity issuer. */
export const isDebtDeriv = (s) => /\d[.,]\d/.test(s) || /\d{1,2}\/\d{2}/.test(s)
  || /\b(NT|NOTE|NOTES|BOND|BONDS|DEB|DEBENTURE|DUE|MTN|PERP|PERPETUAL|SR|SUBORD|SUB|COUPON|MATURES?|FLT|FLOATING|PFD|PREFERRED|PREF|ETN)\b/.test(String(s || '').toUpperCase());

/**
 * Whether a 13F title-of-class describes a derivative or debt position rather than the equity.
 *
 * Used to keep such a row from being EVIDENCE of what a CUSIP is — an options line carries a
 * pseudo-CUSIP and the sponsor's name, so letting it speak for the security is one of the ways an
 * unrelated instrument acquires a ticker. It is deliberately not used to delete anything.
 *
 * UNIT is absent on purpose: in a 13F class field it almost always means an ETF creation unit or a
 * trust unit, which IS the equity position.
 */
// "W EXP <date>" is the shape filers use for a warrant when they do not write the word — Innovid's
// 457679116 line reads "W EXP 11/30/2027". A bare \bW\b would be far too broad; this is not.
export const isDerivativeClass = (cls) => /\b(OPTION|OPTIONS|PUT|PUTS|CALL|CALLS|WARRANT|WARRANTS|WT|WTS|RIGHT|RIGHTS|NOTE|NOTES|NT|BOND|BONDS|DEB|DEBENTURE|CONVERTIBLE|CONV|PFD|PREFERRED|PREF)\b|\bW\s+EXP\b/
  .test(String(cls || '').toUpperCase());

/** Two issuer names denote the same issuer. Equality of cores, never prefix containment. */
export const sameIssuer = (a, b) => {
  const x = ncore(a), y = ncore(b);
  return !!x && x.length >= 3 && x === y;
};
