// Does the Terminal's X Tape actually learn about new posts, or does it only think it does?
//
// The tape is X's own cross-origin embed: we cannot read a single pixel of it from here, so no
// script can assert "the post is on screen". What it CAN assert is the thing the tape now keys off
// — /api/x-tape/head, the newest post id on the list. If that id moves within seconds of a post
// being published, the rebuild trigger is real; if it sits still while the list moves, the tape is
// blind and no amount of rebuilding would help.
//
// This talks ONLY to our own endpoint, so running it does not spend the syndication rate limit that
// the tape itself depends on.
//
//   node scripts/verify-xtape.mjs                      # production
//   node scripts/verify-xtape.mjs http://localhost:3000
//   node scripts/verify-xtape.mjs https://catalystpit.com 30    # watch for 30 minutes
//
// Reports, per observed head change: the post's own publish time, when our endpoint first served
// it, and the gap between them — the true "how late is the tape allowed to be" number.

const BASE = (process.argv[2] || 'https://catalystpit.com').replace(/\/$/, '');
const MINUTES = Number(process.argv[3] || 15);
const POLL_MS = 8000;

const stamp = (t = Date.now()) => new Date(t).toISOString().slice(11, 19);
const secs = (ms) => (ms / 1000).toFixed(0) + 's';

const head = async () => {
  const r = await fetch(`${BASE}/api/x-tape/head`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

console.log(`verifying X Tape freshness against ${BASE} for ${MINUTES} min`);

let first;
try { first = await head(); } catch (e) { console.log(`  FAIL  /api/x-tape/head is not reachable: ${e.message}`); process.exit(1); }
if (!first.id) {
  console.log('  head signal unavailable right now (X is rate-limiting our server, or the list is empty).');
  console.log('  The tape falls back to its 60s timer in this state, so it still refreshes — just blindly.');
} else {
  console.log(`  head ${first.id} published ${stamp(first.at)} (${secs(Date.now() - first.at)} ago), ${first.n} entries`);
}

const deadline = Date.now() + MINUTES * 60_000;
let seen = first.id;
let changes = 0;
let unavailable = 0;
let polls = 0;
const lags = [];

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  polls++;
  let h;
  try { h = await head(); } catch (e) { console.log(`${stamp()} poll failed: ${e.message}`); continue; }
  if (!h.id) { unavailable++; continue; }
  if (h.id === seen) continue;
  changes++;
  const lag = Date.now() - h.at;
  lags.push(lag);
  console.log(`${stamp()} NEW HEAD ${h.id} — published ${stamp(h.at)}, surfaced by us ${secs(lag)} later`);
  seen = h.id;
}

console.log('');
console.log(`polls                : ${polls}`);
console.log(`head changes seen    : ${changes}`);
console.log(`signal unavailable   : ${unavailable} poll(s)${unavailable ? '  (tape was on its 60s timer for these)' : ''}`);
if (lags.length) {
  const sorted = [...lags].sort((a, b) => a - b);
  console.log(`detection lag        : median ${secs(sorted[Math.floor(sorted.length / 2)])}, worst ${secs(sorted.at(-1))}`);
  console.log('');
  console.log('Each of those is a post the tape rebuilt for. Add the rebuild itself (~1-3s) to get the');
  console.log('time from publication to the post being on screen.');
} else if (changes === 0) {
  console.log('');
  console.log('No head change in the window — the list genuinely did not post. That is the state that is');
  console.log('easiest to mistake for a broken tape: quiet gaps of 15+ minutes are normal on this list.');
}
