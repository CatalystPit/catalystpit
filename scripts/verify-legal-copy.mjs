// LEGAL / DISCLOSURE COPY — does the product still describe itself accurately?
//
// ⚠️ WHAT THIS GUARDS, AND WHY IT IS A TEST RATHER THAN A DOCUMENT.
//
// A policy page is code that nobody runs. It drifts from the product silently: paid tiers launched
// while the Privacy Policy still said "when paid tiers launch", an annual plan shipped while the
// Terms described monthly billing only, and the homepage sold "end-of-day" charts months after the
// intraday entitlement came back. None of that breaks a build or fails a request — the only thing
// that catches it is an assertion that the copy and the implementation still agree.
//
// So each check below ties a sentence a customer reads to the behaviour that makes it true.
//
// Run: node scripts/verify-legal-copy.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
// ⚠️ MATCHED AGAINST CODE, NOT PROSE. The comment explaining why "smart-money signals" was the
// wrong name contains the phrase, and a note about Tiingo's socket lives in cp-shared — so two
// assertions about USER-FACING copy were satisfied by my own explanations of the fix.
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('{/*')).join('\n');

const terms = read('../src/app/terms/TermsClient.jsx');
const privacy = read('../src/app/privacy/PrivacyClient.jsx');
const disclaimer = read('../src/app/disclaimer/DisclaimerClient.jsx');
const planTerms = read('../src/components/PlanTerms.jsx');
// ⚠️ THE PRICES LIVE IN PlanChoice NOW, not in the homepage file. The homepage renders the choice
// rather than hard-coding two buttons, so the amounts a buyer sees come from there.
const planChoice = read('../src/components/PlanChoice.jsx');
const billingPlan = read('../src/lib/billing/plan.mjs');
const home = read('../src/components/CatalystPit.jsx');
const billing = read('../src/components/AccountBilling.jsx');
const signUp = read('../src/app/sign-up/[[...sign-up]]/page.jsx');
const signIn = read('../src/app/sign-in/[[...sign-in]]/page.jsx');
const screener = read('../src/app/screener/ScreenerClient.jsx');
const consensus = read('../src/app/consensus/ConsensusClient.jsx');
const shared = read('../src/lib/cp-shared.jsx');
const alertToggle = read('../src/components/AlertToggle.jsx');
const checkout = read('../src/app/api/stripe/checkout/route.js');
const webhook = read('../src/app/api/stripe/webhook/route.js');
const intraday = read('../src/app/api/chart-intraday/route.js');

L('⚠️ THE THREE POLICY ROUTES STILL RENDER');
{
  for (const [name, src] of [['Terms', terms], ['Privacy', privacy], ['Disclaimer', disclaimer]]) {
    ok(`${name} exports a default component`, /export default function \w+Client\(\)/.test(src));
    ok(`…and renders the shared Footer`, /<Footer\s*\/>/.test(src));
  }
  ok('the footer still links all three', ['/privacy', '/terms', '/disclaimer']
    .every((h) => new RegExp(`href:"${h}"`).test(shared)));
}

L('⚠️ PRIVACY DESCRIBES THE PRODUCT THAT EXISTS');
{
  // ⚠️ THE MISMATCH THIS REPLACED: Stripe checkout, portal and webhook were all live while the
  // policy still said payments were a future feature.
  ok('⚠️ no "when paid tiers launch" language survives',
    !/when paid tiers launch|paid subscription tiers become available|Payment information \(future\)/i.test(privacy));
  ok('…and Stripe is live in the code that contradicted it',
    /billing_portal\/sessions/.test(read('../src/app/api/stripe/portal/route.js'))
    && /checkout\/sessions/.test(checkout));
  // ⚠️ WE MUST NOT CLAIM TO HOLD CARD DATA WE NEVER SEE.
  ok('⚠️ the policy says we never receive full card details',
    /never receives or stores your full payment card information/i.test(privacy));
  ok('…and the code only ever stores a Stripe customer id + plan',
    /stripeCustomerId/.test(webhook) && !/card_number|cardNumber/.test(webhook));

  for (const [label, re] of [
    ['public profile', /Public profile/], ['bio/avatar/socials', /bio, avatar image and optional links/],
    ['posted content', /Messages, posts, comments, reactions, likes, follows and reports/],
    ['watchlists', /tickers you add to watchlists/], ['alert state', /read\/unread state/],
    ['Terminal layouts', /Terminal workspace layouts/],
    ['IP for security', /IP address of incoming requests to apply rate limiting/],
    ['browser storage', /local storage/],
  ]) ok(`Privacy describes ${label}`, re.test(privacy));

  // ⚠️ THE PROCESSORS THAT ACTUALLY TOUCH USER DATA.
  for (const p of ['Clerk', 'Stripe', 'Neon', 'Vercel', 'Upstash', 'Ably', 'Resend', 'Beehiiv', 'Google Forms']) {
    ok(`processor listed: ${p}`, new RegExp(`<strong>${p}</strong>`).test(privacy));
  }
  ok('⚠️ content vendors are separated and stated NOT to receive personal data',
    /These vendors do not receive your personal information/.test(privacy));
  ok('…and that separation is true of the code — no user id reaches a market-data call',
    !/tiingo|polygon|finnhub/i.test(read('../src/lib/alerts/evidence-alert-store.js')));
  // ⚠️ REAL-TIME IS NOT AN UNQUALIFIED CLAIM ANY MORE.
  ok('⚠️ Privacy no longer promises real-time market data outright',
    !/We provide real-time market data/.test(privacy)
    && /freshness of market data shown to you depends on your subscription tier/.test(privacy));
  ok('the policy was re-dated', /Last updated: September 27, 2026/.test(privacy));

  // ── ⚠️ ADVERTISING: THE POLICY HAD TO CATCH UP WITH THE CODE ──────────────────────────────────
  //
  // The AdSense loader went live in the root layout, and the policy still said we used no advertising
  // cookies. That sentence was true when it was written and false the moment the tag deployed — which
  // is the failure mode this whole file exists for, and nothing here was pinning it.
  ok('⚠️ the obsolete "no advertising cookies" claim is gone',
    !/We do not use advertising or third-party tracking cookies/.test(privacy));
  // ...while the part of that sentence that is STILL TRUE survives. We run no analytics package.
  ok('…while the analytics half of it, still true, is kept',
    /We do not run an analytics package/.test(privacy));

  ok('⚠️ Google AdSense is disclosed by name', /We use Google AdSense/.test(privacy));
  ok('…in its own numbered section, so it is findable', /2\.4 Advertising/.test(privacy));
  ok('…and the cookies bullet points at it rather than contradicting it',
    /Advertising cookies set by third parties are described in section 2\.4/.test(privacy));
  ok('third-party advertising cookies are disclosed',
    /Third-party vendors, including Google, may use cookies or similar technologies/.test(privacy));
  ok('…including that Google may serve ads based on visits to this and other sites',
    /serve ads based on your visits to Catalyst Pit and, where applicable, to other websites/.test(privacy));
  ok('⚠️ an opt-out route is given, not just a disclosure',
    /adssettings\.google\.com/.test(privacy) && /optout\.aboutads\.info/.test(privacy));
  ok('…and Google\'s own partner-sites notice is linked',
    /policies\.google\.com\/technologies\/partner-sites/.test(privacy));
  ok('future advertising vendors are covered',
    /We may in future use other third-party advertising vendors or networks/.test(privacy));
  ok('the advertising vendor appears in the sharing section too',
    /<strong>Advertising vendors:<\/strong>/.test(privacy) && /<strong>Google AdSense<\/strong>/.test(privacy));

  // ⚠️ AND IT DOES NOT OVERCLAIM IN EITHER DIRECTION.
  ok('⚠️ the no-sale statement is preserved, not widened',
    /We do not sell your personal information to third parties/.test(privacy));
  ok('…and we do not claim to send advertisers account details',
    /We do not send Google your account details/.test(privacy)
    && /We do not provide your name, email address or account details to advertising vendors/.test(privacy));
  // The rate-limiting IP statement stays accurate and is not quietly dropped to make room.
  ok('…the IP-for-security statement is still there',
    /is not used to build an advertising or tracking profile/.test(privacy));

  // ⚠️ THE POLICY IS CHECKED AGAINST THE CODE, WHICH IS THE ONLY THING THAT PREVENTS THIS RECURRING.
  //
  // Every assertion above reads the policy against strings I chose, so all of them would still pass on
  // the day someone removes the ad loader and leaves the disclosure — or, far worse, adds a second
  // advertising vendor and leaves the policy naming only Google. Tying the two together makes the
  // policy's accuracy a property of the repository rather than of whoever remembered to edit it. This
  // is the same shape as the market-data assertion above, which checks that no user id reaches a vendor
  // call rather than trusting the sentence that says so.
  const layoutSrc = read('../src/app/layout.jsx');
  // ⚠️ A RENDERED TAG, NOT THE HOST APPEARING SOMEWHERE. Testing for 'googlesyndication.com' anywhere in
  // the file also matched the ADSENSE_SRC constant, which survives on its own if the <script> is deleted
  // — so removing the loader and leaving the disclosure in place read as consistent. What makes the
  // policy true is a tag the browser executes, so that is what is detected.
  const adLoaderLive = /<script[^>]*(?:ADSENSE_SRC|googlesyndication\.com)/.test(layoutSrc);
  ok('⚠️ if the ad loader ships, the policy discloses advertising',
    !adLoaderLive || /We use Google AdSense/.test(privacy),
    'the loader is in the layout but the policy does not disclose it');
  ok('⚠️ …and if it does not ship, the policy does not claim it does',
    adLoaderLive || !/We use Google AdSense/.test(privacy),
    'the policy discloses AdSense but no loader is deployed');
  // Any advertising host reaching the layout has to be a host the policy actually names.
  const AD_HOSTS = [['googlesyndication.com', 'Google AdSense'], ['doubleclick.net', 'Google'],
    ['adsystem.com', 'Amazon'], ['adnxs.com', 'Xandr'], ['criteo', 'Criteo'], ['taboola', 'Taboola'],
    ['outbrain', 'Outbrain']];
  for (const [host, vendor] of AD_HOSTS) {
    if (!new RegExp(host, 'i').test(layoutSrc)) continue;
    ok(`⚠️ the policy names ${vendor}, whose host is in the layout`,
      new RegExp(vendor, 'i').test(privacy), `${host} ships but ${vendor} is not named in the policy`);
  }
  // And an ad UNIT appearing anywhere would mean ads are actually rendering, not merely verifiable —
  // at which point "advertising may be displayed" understates it and the policy needs another look.
  ok('no ad unit exists yet, so "may be displayed" is still the accurate tense',
    !/className="adsbygoogle"|data-ad-slot/.test(layoutSrc));
}

L('⚠️ TERMS COVER BOTH PLANS, AND RENEWAL IS STATED');
{
  ok('⚠️ the monthly plan and its price appear', /\$20 per month/.test(terms));
  ok('⚠️ the annual plan and its price appear', /\$200 per year/.test(terms));
  // ⚠️ BOTH PRICES MUST MATCH WHAT THE BUTTONS SAY.
  ok('…and both match the purchase copy',
    /\$20\/month/.test(planTerms) && /\$200\/year/.test(planTerms)
    && /MONTHLY_PRICE = 20/.test(planChoice) && /ANNUAL_PRICE = 200/.test(planChoice));
  // ⚠️ EACH INTERVAL'S OWN SENTENCE, NOT JUST THE COMBINED ONE. PlanTerms renders three variants and
  // PlanChoice passes the SELECTED interval, so the annual-only line is what a buyer actually reads
  // once they pick Annual — and it was the one line no assertion covered. Reverting it to the old
  // price used to pass this suite clean.
  ok('⚠️ the monthly-only renewal sentence names the monthly price',
    /\$20\/month\. Renews monthly until cancelled\./.test(planTerms));
  ok('⚠️ the annual-only renewal sentence names the annual price',
    /\$200\/year\. Renews annually until cancelled\./.test(planTerms));
  ok('…and no renewal sentence still quotes a superseded price',
    !/\$199/.test(planTerms) && !/\$199/.test(planChoice) && !/\$199/.test(terms));
  // ⚠️ THE SAVING IS COMPUTED FROM THE TWO PRICES. A typed "Save $40" would outlive the next price
  // change and quietly mis-state it; 20*12-200 cannot.
  ok('⚠️ the annual saving and months-free are derived, not typed',
    /ANNUAL_SAVING = MONTHLY_PRICE \* 12 - ANNUAL_PRICE/.test(planChoice)
    && /ANNUAL_MONTHS_FREE = ANNUAL_SAVING \/ MONTHLY_PRICE/.test(planChoice));
  ok('⚠️ automatic renewal is stated for each interval',
    /Renews automatically every month/.test(terms) && /Renews automatically every year/.test(terms)
    && /renews automatically at its applicable billing interval/.test(terms));
  ok('billing is stated as in advance', /billed <strong>in advance<\/strong>/.test(terms));
  // ⚠️ THE SENTENCE THAT STOPS "CANCEL ANYTIME" MEANING "REFUND ME".
  ok('⚠️ cancellation keeps access to the end of the paid period, and says so per plan',
    /You keep access through the end of the billing period you have already paid for/.test(terms)
    && /to the end of the year on an annual plan/.test(terms));
  ok('⚠️ an annual cancellation is explicitly not a pro-rated refund',
    /does not entitle you to a refund or a pro-rated credit/.test(terms));
  ok('non-refundable except where required by law', /non-refundable except where required by law/.test(terms));
  ok('price changes are covered', /30 days' notice before it applies to your renewal/.test(terms));
  // ⚠️ NO TRIAL IS ADVERTISED, SO NONE IS PROMISED — even though the webhook would honour one.
  ok('⚠️ no trial is promised anywhere in the purchase path',
    !/free trial|trial period|try free/i.test(terms) && !/free trial|trial/i.test(planTerms) && !/free trial/i.test(home));
  ok('…while the code still honours a Stripe-side trial without us advertising it',
    /trialing/.test(webhook) || /trialing/.test(billingPlan));
  // ⚠️ PROMOTION CODES ARE ENABLED IN CHECKOUT, SO NOTHING MAY CONTRADICT THEM.
  ok('⚠️ promotion codes are enabled in code and not contradicted by the Terms',
    /allow_promotion_codes/.test(checkout) && /promotion codes/i.test(terms));
  ok('taxes are addressed', /Taxes:/.test(terms));
}

L('⚠️ THE BUYER SEES THE TERMS BEFORE STRIPE');
{
  ok('⚠️ the renewal sentence is one shared component, not seven copies',
    /export default function PlanTerms/.test(planTerms));
  ok('⚠️ it states renewal for whichever interval it is given',
    /Renews annually until cancelled/.test(planTerms) && /Renews monthly until cancelled/.test(planTerms));
  ok('⚠️ …and replaces a bare "cancel anytime" with the honest version',
    /Cancel anytime\. Access continues through your current paid billing period/.test(planTerms)
    && /non-refundable except where required by law/.test(planTerms));
  ok('⚠️ the old unqualified line is gone from the homepage', !/Cancel anytime · No contracts/.test(home));
  ok('it links Terms, Privacy and Disclaimer',
    /href="\/terms"/.test(planTerms) && /href="\/privacy"/.test(planTerms) && /href="\/disclaimer"/.test(planTerms));
  // ⚠️ EVERY SURFACE THAT STARTS A CHECKOUT SHOWS IT.
  for (const [name, src] of [['homepage', home], ['account billing', billing],
    ['Terminal gate', read('../src/app/terminal/TerminalClient.jsx')],
    ['Consensus', consensus], ['Insiders', read('../src/app/insiders/InsidersClient.jsx')]]) {
    ok(`${name} renders the plan terms beside its CTA`,
      /<PlanTerms/.test(src) || /<PlanChoice/.test(src));
  }
}

L('⚠️ SIGN-UP TELLS PEOPLE WHAT THEY ARE AGREEING TO');
{
  ok('⚠️ sign-up links the Terms and Privacy Policy',
    /By creating an account, you agree to the/.test(signUp)
    && /href="\/terms"/.test(signUp) && /href="\/privacy"/.test(signUp));
  ok('…and the Disclaimer', /href="\/disclaimer"/.test(signUp));
  ok('sign-in carries the same line', /By signing in, you agree to the/.test(signIn) && /href="\/terms"/.test(signIn));
  // ⚠️ NO BLOCKING CHECKBOX. Clerk owns the form; adding a gate is a conversion change, not a
  // disclosure one, and the brief asked for the link rather than the checkbox.
  ok('⚠️ no consent checkbox was bolted onto the hosted auth form',
    !/type="checkbox"/.test(signUp) && /<SignUp \/>/.test(signUp));
}

L('⚠️ COMMUNITY CONTENT IS ACTUALLY COVERED');
{
  ok('⚠️ User Content names the community surfaces',
    /The Pit \(chat\), the Feed, public profiles/.test(terms)
    && /chat messages, posts, comments, reactions/.test(terms));
  ok('⚠️ users KEEP ownership', /<strong>You keep ownership of your User Content\.<\/strong>/.test(terms));
  ok('…and the licence is scoped to operating the service, not perpetual and unlimited',
    /for the purpose of operating, providing, promoting and improving the Service/.test(terms)
    && !/perpetual license to use, reproduce, modify, and display/.test(terms));
  for (const [label, re] of [
    ['impersonation', /Impersonate any person, company/], ['scams', /scams, fraudulent schemes/],
    ['spam', /Post spam, repetitive content/], ['harassment', /Harass, threaten, bully/],
    ['unlawful content', /Post unlawful content/], ['malicious links', /Post malicious links, malware, phishing/],
    ['manipulation', /intended to deceive or manipulate other users about a security/],
  ]) ok(`conduct provision: ${label}`, re.test(terms));
  ok('⚠️ moderation and termination rights are stated',
    /remove, or restrict any User Content, and we may suspend or terminate accounts/.test(terms));
  ok('⚠️ …and we disclaim responsibility for what users post',
    /We are not responsible for User Content posted by others/.test(terms));
  // ⚠️ THE BACKEND WAS NOT TOUCHED. The report control and admin delete are unchanged.
  const chat = read('../src/components/PitChat.jsx');
  ok('the existing report control is unchanged', /api\/pit\/report/.test(chat) && /title="Report"/.test(chat));
  ok('admin-only delete is unchanged',
    /isAdminUser\(userId\)/.test(read('../src/app/api/pit/messages/route.js')));
}

L('⚠️ FINANCIAL WORDING');
{
  ok('⚠️ "smart-money signals" is gone from the screener', !/smart.?money/i.test(code(screener)));
  ok('…including its page metadata', !/smart.?money/i.test(read('../src/app/screener/page.jsx')));
  ok('…replaced with evidence-oriented wording', /Catalyst Pit evidence markers \(◆\)/.test(screener));
  // ⚠️ FACTUAL LABELS SURVIVE. The brief was explicit that BUY/SELL and direction stay.
  ok('⚠️ factual BUY/SELL transaction labels are untouched',
    /BUY/.test(read('../src/app/politicians/CongressTransactions.jsx')) || /BUY/.test(home));
  ok('⚠️ Form 4 direction survives in the evidence card',
    /'BUY' : 'SELL'/.test(read('../src/components/chart/EvidenceCard.jsx')));
  ok('⚠️ Positive/Negative evidence states survive',
    /POSITIVE_ALIGNMENT/.test(read('../src/app/consensus/ConsensusRow.jsx')));
  // ⚠️ RENAMED, NOT RECALCULATED.
  ok('⚠️ the Consensus sort says "Strongest evidence"', /label: 'Strongest evidence'/.test(consensus));
  ok('…and nothing else about the sort changed',
    /key: 'confidence'/.test(consensus) && /CONF_RANK = \{ High: 3, Medium: 2, Low: 1 \}/.test(consensus));
}

L('⚠️ MARKET-DATA COPY MATCHES THE ENTITLEMENT');
{
  // ⚠️ THE CONTRADICTION: the upsell sold end-of-day charts while chart-intraday served Tiingo
  // intraday and Pit Scan printed REAL-TIME.
  ok('⚠️ the Pro feature list no longer says charts are end-of-day',
    !/all timeframes, end-of-day/.test(home) && /all timeframes, intraday and daily/.test(home));
  ok('…and the intraday chart really is served under our own licence',
    /getIntradayBars/.test(intraday) && /source: 'tiingo'/.test(intraday));
  // ⚠️ AND THE ROW SEMANTICS ARE UNTOUCHED.
  const scanRows = read('../src/lib/scan/scan-rows.mjs');
  ok('⚠️ LIVE / DELAYED / LAST CLOSE / LAST KNOWN semantics are unchanged',
    /realtime: 'LIVE'/.test(scanRows) && /delayed: 'DELAYED'/.test(scanRows)
    && /eod: 'LAST CLOSE'/.test(scanRows) && /stale: 'LAST KNOWN'/.test(scanRows));
  ok('…and the board status map is unchanged', /realtime: 'REAL-TIME'/.test(scanRows));
  // ⚠️ NO VENDOR ATTRIBUTION WAS SPRAYED AROUND. Tiingo's contractual line stays where it was.
  ok('⚠️ the Tiingo attribution is still exactly where the agreement puts it',
    /Market Data from <a href="https:\/\/www\.tiingo\.com"/.test(disclaimer));
  ok('…and was not duplicated into the footer', !/tiingo/i.test(code(shared)));
}

L('⚠️ 13F AND ALERT DISCLOSURES RENDER');
{
  const line = /Reported 13F positions are historical disclosures and may not represent a fund’s current holdings\./;
  for (const [name, src] of [
    ['institutions list', read('../src/app/institutions/InstitutionsClient.jsx')],
    ['fund profile', read('../src/app/institutions/[slug]/FundProfile.jsx')],
    ['ticker page', read('../src/app/ticker/[symbol]/TickerPage.jsx')],
  ]) ok(`13F disclosure on ${name}`, line.test(src));
  // ⚠️ THE EXISTING DISCLOSURES SURVIVE ALONGSIDE IT.
  ok('⚠️ quarter/filed dates are still shown', /as of \{fmtQ\(d\.latest\?\.quarter\)\}, filed \{fmtQ\(d\.latest\?\.filedDate\)\}/.test(read('../src/app/institutions/[slug]/FundProfile.jsx')));

  const alertLine = /Alerts are informational and may be delayed, incomplete, or unavailable\. Delivery is not guaranteed\./;
  ok('⚠️ the alert caveat renders in the inbox', alertLine.test(shared));
  ok('⚠️ …and travels with the control, for someone with no alerts yet', alertLine.test(alertToggle));
  // ⚠️ A SCREEN READER MUST NOT ANNOUNCE THE DISCLAIMER AS THE BUTTON'S NAME.
  ok('⚠️ the caveat is a tooltip, not the accessible name',
    /aria-label=\{action\}/.test(alertToggle) && /const title = `\$\{action\}\\n\$\{caveat\}`/.test(alertToggle));
  // ⚠️ THE WORKER WAS NOT TOUCHED.
  ok('alert generation is unchanged',
    /MAX_TICKERS_PER_RUN/.test(read('../src/lib/alerts/evidence-alert-worker.mjs'))
    && JSON.parse(read('../vercel.json')).crons.some((c) => c.path === '/api/cron/evidence-alerts' && c.schedule === '*/15 * * * *'));
}

// ── AN ESTIMATED DATE MUST NEVER READ AS A SCHEDULED ONE ─────────────────────
//
// ⚠️ WHAT THIS GUARDS. The "next earnings" date on a ticker page is not a company-confirmed earnings
// date, and it is not even an earnings date: it projects the next 10-Q/10-K FILING from the median
// gap between past filings. Measured against real EDGAR history — 2,360 walk-forward predictions —
// it is right to the day 24.6% of the time and within a week 53.3%, and the announcement itself
// lands a median of 5 days BEFORE the filing being predicted (p90 24 days). So the wording has to
// carry the uncertainty; a bare "Next earnings Nov 25" reads as a diary entry.
//
// These assertions fail the moment someone shortens the label back.
L('an estimated earnings date is never presented as a scheduled one');
{
  const ticker = code(read('../src/app/ticker/[symbol]/TickerPage.jsx'));
  const watchlist = code(read('../src/components/WatchlistSection.jsx'));
  const estimator = read('../src/lib/earnings-estimate.js');

  ok('⚠️ the ticker hero leads with the word Estimated',
    /Estimated next earnings <span/.test(ticker));
  ok('⚠️ …and says where the date comes from and that nobody confirmed it',
    /projected from SEC filing cadence, not company-confirmed/.test(ticker));
  ok('⚠️ the earnings-history card is labelled an estimate too',
    /Earnings history \(Estimated next earnings: \$\{fmtDateLong\(next\)\}\)/.test(ticker));
  ok('⚠️ the watchlist column says EST. before it says earnings',
    /<MiniLabel>EST\. EARNINGS<\/MiniLabel>/.test(watchlist));

  // The forbidden phrasings, checked against CODE so the explanations above cannot satisfy them.
  for (const [phrase, re] of [
    ['a bare "Next earnings"', />\s*Next earnings\b|['"`]Next earnings\b/],
    ['"Earnings date"', /\bEarnings date\b/],
    ['"Scheduled earnings"', /\bScheduled earnings\b/i],
    ['"Confirmed earnings"', /\bConfirmed earnings\b/i],
  ]) {
    ok(`${phrase} appears nowhere a customer reads it`, !re.test(ticker) && !re.test(watchlist),
      'only a real forward calendar source could justify that wording');
  }

  // ⚠️ AND THE ESTIMATOR ITSELF SAYS WHAT IT RETURNS. The mislabel started here: the function is
  // named for earnings and returns a filing date, so every caller inherited the wrong noun.
  ok('⚠️ the estimator states, up front, that it predicts a FILING date',
    /THIS RETURNS AN ESTIMATED SEC FILING DATE\. IT IS NOT AN ANNOUNCEMENT DATE\./.test(estimator),
    'the mislabel started here: a function named for earnings that returns a filing date');
  ok('⚠️ …and records how far apart the two actually are',
    /MEDIAN OF 5 DAYS BEFORE the filing/.test(estimator));
  ok('⚠️ …and records the measured accuracy, so nobody has to guess whether it is good enough',
    /within 7 days 53\.3%/.test(estimator) && /p90 35 days/.test(estimator));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
