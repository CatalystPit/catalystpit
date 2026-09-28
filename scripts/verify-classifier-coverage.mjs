// CLASSIFIER COVERAGE — does one real event get recognised however the wire words it?
//
// ⚠️ WHY THIS SUITE EXISTS. NVIDIA authorised $150bn of buybacks and Catalyst Pit classified it —
// but only from the two copies that used the word "Authorization". "Nvidia launches record $150bn
// share buyback", "Nvidia Adds Record $150 Billion to Stock Buyback" and "Nvidia adds $150 billion
// to existing share repurchase plan" all classified as NOTHING. The event survived by luck: one
// issuer wire and one desk happened to pick the vocabulary the pattern knew.
//
// That is a systemic risk, not a buyback one. A catalyst class whose pattern only matches one
// phrasing is a coin flip on which outlet files first, and a watchlist badge built on it is a coin
// flip too. So every major class below is tested against SEVERAL legitimate wordings of the SAME
// event, and against near-miss phrasings that must NOT classify.
//
// ⚠️ AND THE NEGATIVES ARE THE POINT. Widening a pattern until every variant passes is trivial and
// wrong — it turns commentary, roundups and speculation into canonical events. Each class here
// carries its own "must not match" list, and they are as load-bearing as the positives.
//
// Run: node scripts/verify-classifier-coverage.mjs

import { classifyCompanyEvent, COMPANY_EVENTS } from '../src/lib/evidence/company-events.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);

/** Every wording in `yes` must produce `type`; every wording in `no` must produce something else. */
function coverage(label, type, yes, no = []) {
  L(label);
  let hits = 0;
  for (const h of yes) {
    const got = classifyCompanyEvent(h, null);
    const good = got?.type === type;
    if (good) hits++;
    ok(`"${h.slice(0, 62)}" → ${type}`, good, got ? `got ${got.type}` : 'classified as nothing');
  }
  for (const h of no) {
    const got = classifyCompanyEvent(h, null);
    ok(`⚠️ NOT ${type}: "${h.slice(0, 54)}"`, got?.type !== type, got ? `got ${got.type}` : '');
  }
  console.log(`  ${hits}/${yes.length} wordings recognised`);
}

// ── A. BUYBACKS — the class the NVDA failure exposed ─────────────────────────
coverage('A. share repurchase authorisation', 'cap_buyback_authorized', [
  'Acme authorizes $10 billion share repurchase program',
  'Acme Corp launches $10B buyback',
  'Acme announces new $10 billion share repurchase program',
  'Acme approves new repurchase program',
  'Acme adds $10 billion to existing share repurchase plan',
  'Acme expands share repurchase authorization by $5 billion',
  'Acme Board authorizes additional $150 billion under existing repurchase program',
  'Acme boosts buyback program by $150 billion',
  'Acme increases share repurchase authorization to $20 billion',
  'Acme Adds Record $150 Billion to Stock Buyback',
], [
  // Commentary, execution reporting and speculation are not the authorisation.
  'Why Acme’s buyback may not be enough to support the stock',
  'Acme repurchased 2.1 million shares during the quarter',
  'Acme could announce a buyback, analyst says',
]);

// ── B. M&A ───────────────────────────────────────────────────────────────────
// The taxonomy separates the AGREEMENT from the COMPLETION and from an unsolicited PROPOSAL, which
// is right — they are different facts. All the ordinary ways of saying "we are buying this company"
// land on the agreement.
coverage('B. acquisition agreed', 'ma_agreement', [
  'Acme to acquire Beta Corp for $2 billion',
  'Acme acquires Beta Corp',
  'Acme agrees to buy Beta Corp in cash deal',
  'Acme and Beta Corp enter into merger agreement',
  'Acme to combine with Beta Corp',
  'Acme announces takeover of Beta Corp',
], [
  'Acme rumoured to be weighing a bid for Beta Corp',
  'Why the Acme-Beta deal could face antitrust scrutiny',
]);

// ── C. CONTRACTS ─────────────────────────────────────────────────────────────
// ⚠️ A CONTRACT MUST CARRY A SIZE OR AN ISSUING AUTHORITY, and that is a measured decision, not a
// gap. The unqualified form ("announces partnership", "signs supply agreement") matched constantly
// and meant nothing, and a bare dollar sign let a $349 retail pre-order become a META contract
// award. The three unqualified wordings below are therefore listed as things that must NOT
// classify — widening the class to catch them is the specific mistake this note exists to prevent.
coverage('C. material contract or order award', 'ma_contract_award', [
  'Acme wins $500 million contract with the US Navy',
  'Acme awarded $500 million defense contract',
  'Acme secures $120 million purchase order',
  'Acme receives $75 million task order from the Department of Energy',
], [
  'Acme wins Best Places to Work award',
  'Acme to bid for the upcoming infrastructure contract',
  'Acme selected by Delta Airlines to supply engines',
  'Acme signs supply agreement with Beta Corp',
  'Ray-Ban Acme Audio launches October 13, available for pre-order at $349',
]);

// ── D. MANAGEMENT ────────────────────────────────────────────────────────────
coverage('D. CEO departure', 'mgmt_ceo_departure', [
  'Acme CEO resigns effective immediately',
  'Acme CEO steps down after five years',
  'Acme chief executive departs',
  'Acme announces CEO transition as John Smith will retire',
  'Acme terminates CEO John Smith',
], [
  'Acme CEO to speak at the Beta technology conference',
  'Acme CEO sells 10,000 shares',
]);
coverage('D2. CEO appointed', 'mgmt_ceo_appointed', [
  'Acme names Jane Doe as chief executive officer',
  'Acme appoints Jane Doe CEO',
  'Acme announces Jane Doe as new CEO',
  'Jane Doe named president and chief executive officer of Acme',
], [
  'Acme CEO named to industry hall of fame',
]);

// ── E. GUIDANCE ──────────────────────────────────────────────────────────────
coverage('E. guidance raised', 'earn_guidance_raised', [
  'Acme raises full-year outlook',
  'Acme boosts revenue outlook for fiscal 2026',
  'Acme lifts guidance after strong quarter',
  'Acme increases FY26 earnings guidance',
], ['Analysts raise price target on Acme']);
coverage('E2. guidance lowered', 'earn_guidance_lowered', [
  'Acme cuts guidance for the full year',
  'Acme lowers revenue outlook',
  'Acme reduces FY26 earnings guidance',
  'Acme trims full-year forecast',
], ['Acme shares fall as analysts cut estimates']);
coverage('E3. guidance withdrawn', 'earn_guidance_withdrawn', [
  'Acme withdraws full-year guidance',
  'Acme withdraws guidance',
  'Acme suspends fiscal 2026 guidance',
], [
  // ⚠️ A KNOWN AND DELIBERATE LIMIT. "Acme suspends its outlook amid uncertainty" does not classify:
  // "outlook" is the word banks use about other people's businesses, so it must be anchored to a
  // fiscal period or a metric. Anchoring on a possessive instead was tried and rejected — it would
  // have let "Goldman cuts its Brent oil forecast" become an issuer's own withdrawn guidance.
  'Goldman cuts its Brent oil forecast',
  'BofA raises its 10-year Treasury yield target',
]);

// ── F. CAPITAL RAISES ────────────────────────────────────────────────────────
coverage('F. registered direct offering', 'cap_registered_direct', [
  'Acme announces $30 million registered direct offering',
], []);
coverage('F2. at-the-market programme', 'cap_atm', [
  'Acme establishes $50 million at-the-market offering program',
  'Acme enters into an at-the-market sales agreement',
], []);
coverage('F3. convertible notes', 'cap_convertible', [
  'Acme announces $400 million convertible senior notes offering',
  'Acme to offer $400 million of convertible notes',
], ['Acme completes retirement of its convertible notes']);

// ── the taxonomy itself ──────────────────────────────────────────────────────
L('the taxonomy is well formed');
{
  const types = COMPANY_EVENTS.map((e) => e.type);
  ok('every spec has a type, label, materiality and direction',
    COMPANY_EVENTS.every((e) => e.type && e.label && typeof e.materiality === 'number' && e.direction));
  ok('no duplicate types', new Set(types).size === types.length);
  ok('materiality is a probability', COMPANY_EVENTS.every((e) => e.materiality > 0 && e.materiality <= 1));
  ok('every spec states at least one required pattern', COMPANY_EVENTS.every((e) => Array.isArray(e.all) && e.all.length));
  console.log(`  ${COMPANY_EVENTS.length} company-event classes`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
