// src/lib/congress-match.mjs
//
// Matches FMP congressional-trade names → roster entries to attach
// party / state / chamber / bioguide. FMP gives no party and no clean state,
// so this join is the only way to populate those card fields.
//
// Shared runtime code: imported by the refresh-congress cron route AND by the
// node scripts (build-congress-roster, validate-congress-match, seed-congress).
// Kept as .mjs (pure ESM, no node-only deps beyond what both targets have) so
// both Next and `node` can import it without the CJS/ESM friction that forces
// backfill-insiders.mjs to duplicate the schema.
//
// Design: NO fuzzy/edit-distance matching — on a ~535-person set it produces
// confident-but-wrong matches. Instead: normalize hard, use a political
// nickname equivalence table, and require chamber/state agreement. Anything
// unresolved returns null (member shown with blank party/state, counted as a
// miss) rather than risking a wrong attribution.

export const norm = (s) => (s || '')
  .toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents
  .replace(/['".,]/g, '')                               // strip punctuation
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')              // strip generational suffixes
  .replace(/\s+/g, ' ')
  .trim();

// First name only: drop middle names/initials ("Thomas H." -> "thomas").
export const firstToken = (s) => norm(s).split(' ')[0] || '';

// Political nickname equivalence groups. Any two first names sharing a group
// are treated as equal. A name may belong to several groups (ted, steve, frank…).
const NICK_GROUPS = [
  ['bernard','bernie'], ['michael','mike'], ['james','jim','jimmy'],
  ['william','will','bill','billy'], ['robert','rob','bob','bobby'],
  ['richard','rick','rich','dick'], ['thomas','tom','tommy'], ['daniel','dan','danny'],
  ['david','dave'], ['joseph','joe','joey'], ['jacob','jake'], ['charles','chuck','charlie'],
  ['edward','ed','eddie','ted'], ['theodore','ted','teddy','theo'], ['frederick','fred'],
  ['gregory','greg'], ['benjamin','ben'], ['nicholas','nick'], ['anthony','tony'],
  ['christopher','chris'], ['matthew','matt'], ['nathaniel','nathan','nate'],
  ['patrick','pat'], ['samuel','sam'], ['abigail','abby'], ['elizabeth','liz','beth','lizzie'],
  ['katherine','kathy','kate','katie'], ['catherine','cathy','cate'], ['deborah','debbie','deb'],
  ['jennifer','jen','jenny'], ['margaret','maggie','meg','peggy'], ['susan','sue'],
  ['victoria','vicky'], ['steven','steve'], ['stephen','steve'], ['kenneth','ken'],
  ['ronald','ron'], ['donald','don'], ['gerald','gerry','jerry'], ['lawrence','larry'],
  ['raymond','ray'], ['alexander','alex'], ['andrew','andy','drew'], ['joshua','josh'],
  ['zachary','zach'], ['vincent','vince'], ['francis','frank'], ['franklin','frank'],
  ['walter','walt'], ['russell','russ'], ['douglas','doug'], ['cynthia','cindy'],
  ['patricia','patty','trish'], ['rebecca','becca','becky'], ['jacqueline','jackie'],
  ['kimberly','kim'], ['theresa','terry'], ['terrence','terry'], ['gabriel','gabe'],
  ['eleanor','ellie'], ['gilbert','gil'],
];
const NICK_OF = new Map();
NICK_GROUPS.forEach((grp, i) => grp.forEach(n => {
  if (!NICK_OF.has(n)) NICK_OF.set(n, new Set());
  NICK_OF.get(n).add(i);
}));

const firstNamesMatch = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const ga = NICK_OF.get(a), gb = NICK_OF.get(b);
  if (ga && gb) for (const g of ga) if (gb.has(g)) return true;
  return false;
};

// Last-name lookup keys: the full normalized last name AND its last token.
// FMP routinely leaks middle initials / compound names into the lastName field
// ("Moore Capito", "W. Hickenlooper"); indexing both ends makes the join
// symmetric so either side can be compound.
function lastKeys(nLastStr) {
  const toks = nLastStr.split(' ').filter(Boolean);
  const keys = new Set();
  if (nLastStr) keys.add(nLastStr);
  if (toks.length > 1) keys.add(toks[toks.length - 1]);
  return keys;
}

export function buildIndex(roster) {
  const byLast = new Map();
  for (const e of roster) {
    for (const k of lastKeys(e.nLast)) {
      if (!byLast.has(k)) byLast.set(k, []);
      byLast.get(k).push(e);
    }
  }
  return { byLast };
}

// { firstName, lastName, chamber:'senate'|'house', district } ->
//   { entry, method } | { entry: null, method }
export function matchMember(index, { firstName, lastName, chamber, district }) {
  const nLast  = norm(lastName);
  const nFirst = firstToken(firstName);
  const state  = (district && /^[A-Za-z]{2}/.test(district)) ? district.slice(0, 2).toUpperCase() : null;

  // gather candidates across full-name + last-token keys, deduped
  const byBioguide = new Map();
  for (const k of lastKeys(nLast)) for (const e of index.byLast.get(k) || []) byBioguide.set(e.bioguide, e);
  const cands = [...byBioguide.values()];
  if (cands.length === 0) return { entry: null, method: 'no-lastname' };

  const inChamber = cands.filter(c => c.chamber === chamber);
  const pool = inChamber.length ? inChamber : cands;

  // 1. first name agrees (incl. roster nickname field + nickname table)
  const hit = pool.find(c =>
    firstNamesMatch(nFirst, c.nFirst) || (c.nNick && firstNamesMatch(nFirst, c.nNick)));
  if (hit) return { entry: hit, method: inChamber.length ? 'name+chamber' : 'name-only' };

  // 2. unique last name in the (chamber) pool — safe even if first name is odd
  if (pool.length === 1) return { entry: pool[0], method: 'unique-last' };

  // 3. disambiguate by state (house district prefix)
  if (state) {
    const byState = pool.filter(c => c.state === state);
    if (byState.length === 1) return { entry: byState[0], method: 'state' };
  }

  return { entry: null, method: 'ambiguous' };
}
