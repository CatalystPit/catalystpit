'use client';
import { C, BrandStyles, Logo, Footer } from '../../lib/cp-shared';

// AFFILIATE PROGRAM TERMS — published BEFORE the programme exists, deliberately.
//
// ⚠️ NOTHING HERE IS LIVE. No code on the Service issues referral codes, records attribution,
// calculates commission or pays anyone. These terms are published in advance so they can be read
// before anyone enrols, and every statement about how the programme works is written in the future
// tense for that reason. The banner at the top says so in the first sentence a reader sees, because
// a terms page that reads as though the programme is running is itself a misrepresentation.
//
// ⚠️ WHEN THE PROGRAMME GOES LIVE, four things change together: (1) this file's STATUS banner,
// (2) the "not yet open" paragraph in Terms section 11, (3) the footer link in cp-shared's Footer,
// (4) the effective date below. Changing one without the others leaves the site contradicting itself.
export default function AffiliatesClient() {
  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, minHeight: "100vh", color: C.text }}>
      <BrandStyles/>
      {/* NAV */}
      <div style={{
        background: C.navBg, height: 50, display: "flex", alignItems: "center",
        justifyContent: "space-between", padding: "0 24px", position: "sticky", top: 0, zIndex: 100,
        borderBottom: "1px solid rgba(255,255,255,0.15)"
      }}>
        <a href="/" style={{ textDecoration: "none" }}><Logo dark/></a>
        <a href="/" style={{ fontSize: 12, color: "rgba(255,255,255,0.75)", textDecoration: "none", fontWeight: 300 }}>← Back to homepage</a>
      </div>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px 64px" }}>
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.muted, letterSpacing: "1.5px", marginBottom: 12 }}>
          LEGAL
        </div>
        <h1 style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 34, fontWeight: 700, color: C.ink, margin: "0 0 8px", letterSpacing: "-0.5px", lineHeight: 1.15 }}>
          Affiliate Program Terms
        </h1>
        <p style={{ fontSize: 13, color: C.muted, margin: "0 0 24px", fontWeight: 300 }}>
          Published in advance · Not yet in effect
        </p>

        {/* STATUS — the first thing read, and the claim everything else depends on. */}
        <div style={{ background: C.warnBg, border: `1px solid ${C.gold}`, borderRadius: 8, padding: "18px 20px", margin: "0 0 36px" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.warnFg, marginBottom: 8, letterSpacing: "-0.2px" }}>
            The Catalyst Pit affiliate program is not open yet.
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.6, color: C.warnFg }}>
            We are not accepting affiliates, no referral codes have been issued, no referrals are being
            tracked, and no commission is being earned or owed. These terms are published ahead of
            launch so they can be read in full beforehand. They take effect only on the date we state
            here when the program opens, and enrolment will require accepting them at that time.
          </div>
        </div>

        <Section title="1. What This Document Is">
          <p>These Affiliate Program Terms will govern participation in the Catalyst Pit affiliate program (the &ldquo;Program&rdquo;) once it opens. They supplement our <a href="/terms" style={linkStyle}>Terms of Service</a>, which continue to apply in full. If the two conflict on a Program matter, these terms control.</p>
          <p>Until the Program opens, this page is informational only. It is not an offer, and nothing on the Service creates an affiliate relationship between you and Catalyst Pit.</p>
        </Section>

        <Section title="2. Intended Structure of the Program">
          <p>When the Program opens, we intend it to work as described below. We may change any of this before launch; the version in force will be the one published on this page on the day you enrol.</p>
          <ul style={list}>
            <li><strong>Affiliate codes:</strong> Each approved affiliate will receive one or more unique referral codes or links.</li>
            <li><strong>Attribution requires use of the code:</strong> A referral will only count if the referred customer actually uses the affiliate&rsquo;s code or link during sign-up or checkout. There is no other way to attach a referral.</li>
            <li><strong>No retroactive attribution:</strong> A referral cannot be attached to an account after the fact. If a customer signed up without using a code, that customer is not a referral, and we will not add one later on request.</li>
            <li><strong>Commission:</strong> $5.00 per month, recurring, for each referred member who remains an eligible paying Catalyst Pit Pro subscriber, for as long as that subscription remains in good standing.</li>
            <li><strong>Eligibility of a referred subscriber:</strong> A referred subscriber is eligible only while their subscription is active and paid. Trials, unpaid periods, failed payments, chargebacks, refunded periods and cancelled subscriptions do not earn commission.</li>
          </ul>
          <p style={{ fontWeight: 600 }}>Commission is per referred subscriber, not per transaction, and it is not a share of the price paid. A monthly and an annual subscriber earn the same $5.00 per month while eligible.</p>
        </Section>

        <Section title="3. Adjustments, Refunds and Cancellations">
          <ul style={list}>
            <li><strong>Cancellation:</strong> When a referred subscriber cancels, commission stops at the end of the period for which they have paid. No commission accrues after that.</li>
            <li><strong>Refunds and chargebacks:</strong> If a payment is refunded or charged back, any commission attributable to it will be reversed, and deducted from current or future payouts. If no future payout is due, we may invoice the amount.</li>
            <li><strong>Downgrades and lapses:</strong> A subscriber who returns to the Free tier stops earning commission from the date the paid entitlement ends.</li>
            <li><strong>Reinstatement:</strong> If a cancelled subscriber later resubscribes using no code, they are not re-attributed to the original affiliate.</li>
          </ul>
        </Section>

        <Section title="4. Prohibited Conduct">
          <p>The following will disqualify a referral and may result in removal from the Program and forfeiture of unpaid commission:</p>
          <ul style={list}>
            <li><strong>Self-referral:</strong> Using your own code for your own account, or for accounts you control, or arranging for someone to do so on your behalf.</li>
            <li><strong>Fraud and manipulation:</strong> Fake accounts, stolen or disputed payment methods, incentivised sign-ups intended to be cancelled or refunded, bot traffic, or any scheme whose purpose is to generate commission rather than genuine subscribers.</li>
            <li><strong>Misrepresentation:</strong> Describing yourself as an employee, agent, partner or spokesperson of Catalyst Pit; promising results, returns or investment outcomes; or presenting Catalyst Pit as an investment adviser, broker-dealer or fiduciary. See our <a href="/disclaimer" style={linkStyle}>Financial Disclaimer</a>.</li>
            <li><strong>Unlawful or deceptive promotion:</strong> Spam, unsolicited bulk email or messaging, malware, typosquatting, trademark-bidding on our brand terms where prohibited, or promotion on sites containing illegal or infringing material.</li>
            <li><strong>Undisclosed promotion:</strong> Promoting Catalyst Pit for compensation without disclosing that you are compensated. See section 6.</li>
          </ul>
          <p>We may withhold, reverse or refuse commission on any referral we reasonably believe to be affected by the above, and our determination on attribution and eligibility will be final.</p>
        </Section>

        <Section title="5. Payouts">
          <p>The payout method, minimum payout threshold, payment schedule and any required tax documentation will be stated here before the Program opens, and will be shown during enrolment. Affiliates are responsible for any taxes arising on commission they receive. Commission is paid in U.S. dollars.</p>
          <p>We will not begin accruing commission for anyone until those details are published and the Program is stated on this page to be open.</p>
        </Section>

        <Section title="6. Required Disclosure by Affiliates">
          <p>If you promote Catalyst Pit under the Program, you must clearly and conspicuously disclose that you may receive compensation, in a way and place a reader will actually see, before or at the point they act on your link. This is a condition of participation and is also required by law in many jurisdictions, including under the U.S. Federal Trade Commission&rsquo;s endorsement guidelines.</p>
        </Section>

        <Section title="7. Compensation Received by Catalyst Pit">
          <p>Separately from the Program, Catalyst Pit may itself receive affiliate commission or referral fees from third-party products and services linked from the Service. Where such links appear, they are labelled as affiliate links at the point of display. Receiving compensation does not influence our data, scores, rankings or editorial content, and an affiliate link is never a recommendation to buy or sell any security. See our <a href="/disclaimer" style={linkStyle}>Financial Disclaimer</a>.</p>
        </Section>

        <Section title="8. Term, Changes and Termination">
          <p>Once the Program opens, either party may end participation at any time and for any reason, on notice. We may modify or discontinue the Program, including commission amounts and eligibility rules, with notice to participating affiliates; changes will not reduce commission already properly accrued before the change takes effect.</p>
          <p>We may update these terms before the Program opens without notice, because no one is yet relying on them.</p>
        </Section>

        <Section title="9. No Employment or Partnership">
          <p>Participation in the Program creates an independent-contractor relationship only. It does not create employment, agency, partnership or a joint venture, and it does not give an affiliate authority to make any representation or commitment on behalf of Catalyst Pit.</p>
        </Section>

        <Section title="10. Contact">
          <p>Questions about the Program, including being notified when it opens:</p>
          <ul style={list}>
            <li>Email: <a href="mailto:legal@catalystpit.com" style={linkStyle}>legal@catalystpit.com</a></li>
            <li>Or use our <a href="/contact" style={linkStyle}>contact form</a></li>
          </ul>
          <p style={{ color: C.muted, fontSize: 13 }}>
            CatalystPit<br/>
            Florida, United States
          </p>
        </Section>
      </div>

      <Footer/>
    </div>
  );
}

const list = { margin: "12px 0", paddingLeft: 24, fontSize: 14, lineHeight: 1.7, color: C.text };
const linkStyle = { color: C.green, textDecoration: "none", fontWeight: 500 };

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 36 }}>
      <h2 style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 19, fontWeight: 700, color: C.ink, margin: "0 0 12px", letterSpacing: "-0.2px" }}>
        {title}
      </h2>
      <div style={{ fontSize: 14, lineHeight: 1.7, color: C.text, fontWeight: 400 }}>
        {children}
      </div>
    </div>
  );
}
