'use client';
import { Logo, Footer } from '../../lib/cp-shared';

const C = {
  bg: "#F5F6F3",
  white: "#FFFFFF",
  surface: "#F0F2EE",
  border: "#E0E2DC",
  ink: "#0C1410",
  text: "#1A2018",
  muted: "#5A6458",
  green: "#1E5C38",
  greenMid: "#2A7848",
  navBg: "#1E5C38",
};

export default function TermsPage() {
  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, minHeight: "100vh", color: C.text }}>
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
        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, color: C.muted, letterSpacing: "1.5px", marginBottom: 12 }}>
          LEGAL
        </div>
        <h1 style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 34, fontWeight: 700, color: C.ink, margin: "0 0 8px", letterSpacing: "-0.5px", lineHeight: 1.15 }}>
          Terms of Service
        </h1>
        <p style={{ fontSize: 13, color: C.muted, margin: "0 0 24px", fontWeight: 300 }}>
          Effective date: May 17, 2026 · Last updated: May 17, 2026
        </p>

        <div style={{ background: "#FFF8E8", border: "1px solid #E8D49A", borderRadius: 8, padding: "16px 18px", margin: "0 0 40px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#7A5018", marginBottom: 6 }}>Read this carefully.</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "#5A4010" }}>
            These Terms include important provisions, including an arbitration agreement and class-action waiver in Section 14, that affect your legal rights. By using CatalystPit, you agree to these Terms.
          </div>
        </div>

        <Section title="1. Acceptance of Terms">
          <p>These Terms of Service ("Terms") are a binding agreement between you and CatalystPit (operated by Benjamin Coghill in Edgewater, Florida — referred to as "CatalystPit," "we," "us," or "our"). By accessing or using catalystpit.com, our newsletter "The Catalyst Brief," or any related services (collectively, the "Service"), you agree to be bound by these Terms and our <a href="/privacy" style={linkStyle}>Privacy Policy</a> and <a href="/disclaimer" style={linkStyle}>Financial Disclaimer</a>.</p>
          <p>If you do not agree, do not use the Service.</p>
        </Section>

        <Section title="2. Eligibility">
          <p>You must be at least 18 years old and legally able to enter into a binding contract to use the Service. By using the Service, you represent that you meet these requirements.</p>
        </Section>

        <Section title="3. Your Account">
          <p>To access certain features, you must create an account. You agree to:</p>
          <ul style={list}>
            <li>Provide accurate and complete information</li>
            <li>Keep your login credentials confidential</li>
            <li>Notify us immediately of any unauthorized access</li>
            <li>Take responsibility for all activity on your account</li>
          </ul>
          <p>We may suspend or terminate accounts that violate these Terms, engage in fraud, abuse the Service, or pose a security risk.</p>
        </Section>

        <Section title="4. The Service">
          <p>CatalystPit provides financial intelligence content including market data, news aggregation, AI-enriched summaries, insider trading filings, congressional trading disclosures, and related information. The Service is offered in free and paid subscription tiers.</p>
          <p><strong>The Service is for informational and educational purposes only.</strong> It is not investment advice, financial advice, tax advice, or a recommendation to buy, sell, or hold any security. See our <a href="/disclaimer" style={linkStyle}>Financial Disclaimer</a> for full details.</p>
          <p>We strive for accuracy but do not warrant that information is complete, current, or error-free. Data is sourced from third parties (Polygon.io, GNews, SEC EDGAR, CoinGecko, and others) and may be delayed, inaccurate, or incomplete. Some content is generated or enriched with AI and may contain errors.</p>
        </Section>

        <Section title="5. Subscriptions and Payments">
          <p>Paid subscription tiers ("Pro," "Elite," or as otherwise offered) will be billed in advance on a recurring monthly basis through our payment processor Stripe. By subscribing, you authorize us to charge your payment method on each billing cycle until you cancel.</p>
          <ul style={list}>
            <li><strong>Cancellation:</strong> You may cancel anytime through your account settings. Cancellation takes effect at the end of your current billing cycle. You retain access until then.</li>
            <li><strong>Refunds:</strong> Subscription fees are non-refundable except where required by law. We may offer refunds at our discretion.</li>
            <li><strong>Price changes:</strong> We may change pricing with at least 30 days' notice. If you do not agree, you may cancel before the change takes effect.</li>
            <li><strong>Failed payments:</strong> If a payment fails, we may suspend your access until payment is resolved.</li>
          </ul>
        </Section>

        <Section title="6. Acceptable Use">
          <p>You agree not to:</p>
          <ul style={list}>
            <li>Use the Service for any unlawful purpose</li>
            <li>Scrape, crawl, or use automated tools to extract data without our written permission</li>
            <li>Reverse-engineer, decompile, or attempt to extract source code</li>
            <li>Resell, redistribute, or republish Service content without permission</li>
            <li>Share your account credentials or allow others to use your account</li>
            <li>Bypass paywalls, rate limits, or access controls</li>
            <li>Interfere with the Service's security or operation</li>
            <li>Use the Service to harass, defame, or harm others</li>
            <li>Upload viruses, malware, or other harmful code</li>
            <li>Misrepresent your identity or affiliation</li>
          </ul>
        </Section>

        <Section title="7. Intellectual Property">
          <p>The Service, including its design, code, branding, content, and trademarks, is owned by CatalystPit or its licensors and is protected by copyright, trademark, and other laws. We grant you a limited, non-exclusive, non-transferable, revocable license to access and use the Service for personal, non-commercial purposes in accordance with these Terms.</p>
          <p>Third-party data (market data, news articles, SEC filings) remains the property of its respective owners and is used under license or fair use.</p>
        </Section>

        <Section title="8. User Content">
          <p>If you submit any content to the Service (feedback, suggestions, comments), you grant us a worldwide, royalty-free, perpetual license to use, reproduce, modify, and display that content in connection with operating and improving the Service. You represent that you have the right to grant this license.</p>
        </Section>

        <Section title="9. Third-Party Services">
          <p>The Service includes links to and integrations with third-party services (Beehiiv, Clerk, Stripe, news sources, etc.). We are not responsible for the content, accuracy, or practices of third parties. Your use of those services is governed by their own terms and policies.</p>
        </Section>

        <Section title="10. Disclaimers">
          <p style={{ textTransform: "uppercase", fontSize: 13, letterSpacing: "0.3px", fontWeight: 600, color: C.ink }}>
            THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, OR NON-INFRINGEMENT.
          </p>
          <p>We do not warrant that the Service will be uninterrupted, secure, or error-free, that defects will be corrected, or that the Service is free of viruses or harmful components. You use the Service at your own risk.</p>
          <p>See our <a href="/disclaimer" style={linkStyle}>Financial Disclaimer</a> for additional risk warnings specific to financial information.</p>
        </Section>

        <Section title="11. Limitation of Liability">
          <p style={{ textTransform: "uppercase", fontSize: 13, letterSpacing: "0.3px", fontWeight: 600, color: C.ink }}>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, CATALYSTPIT AND ITS OPERATORS, AGENTS, AND LICENSORS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, REVENUE, DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES, ARISING FROM YOUR USE OF OR INABILITY TO USE THE SERVICE, ANY TRADING DECISIONS MADE BASED ON SERVICE CONTENT, OR ANY UNAUTHORIZED ACCESS TO OR ALTERATION OF YOUR DATA.
          </p>
          <p>In no event will our total liability for all claims relating to the Service exceed the greater of (a) the amount you paid us in the 12 months preceding the event giving rise to the claim, or (b) USD $100.</p>
          <p>Some jurisdictions do not allow the exclusion or limitation of certain damages. In those jurisdictions, our liability is limited to the maximum extent permitted by law.</p>
        </Section>

        <Section title="12. Indemnification">
          <p>You agree to defend, indemnify, and hold harmless CatalystPit, its operators, agents, and licensors from any claims, damages, losses, and expenses (including reasonable attorneys' fees) arising from your violation of these Terms, your use of the Service, or your violation of any rights of a third party.</p>
        </Section>

        <Section title="13. Termination">
          <p>You may terminate your account at any time through your account settings. We may suspend or terminate your access at any time, with or without notice, for any reason, including violation of these Terms or risk to the Service or other users.</p>
          <p>Sections that by their nature should survive termination will survive, including intellectual property, disclaimers, limitation of liability, indemnification, and dispute resolution.</p>
        </Section>

        <Section title="14. Dispute Resolution and Arbitration">
          <p><strong>Please read carefully — this section affects your legal rights.</strong></p>
          <p>Any dispute arising from these Terms or the Service will be resolved through binding individual arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, except that you may bring claims in small-claims court if eligible.</p>
          <p><strong>Class-action waiver:</strong> You and CatalystPit agree to bring disputes only on an individual basis and waive the right to participate in any class, collective, or representative action.</p>
          <p><strong>Opt-out:</strong> You may opt out of this arbitration agreement within 30 days of first accepting these Terms by emailing us at <a href="mailto:legal@catalystpit.com" style={linkStyle}>legal@catalystpit.com</a> with the subject line "Arbitration Opt-Out."</p>
          <p>This section does not prevent either party from seeking injunctive relief for intellectual property violations in court.</p>
        </Section>

        <Section title="15. Governing Law">
          <p>These Terms are governed by the laws of the State of Florida and the United States, without regard to conflict-of-law principles. For any matters not subject to arbitration, you agree to the exclusive jurisdiction of courts located in Volusia County, Florida.</p>
        </Section>

        <Section title="16. Changes to These Terms">
          <p>We may update these Terms from time to time. The "Last updated" date at the top reflects the most recent changes. For material changes, we will notify you by email or through the Service before the changes take effect. Your continued use of the Service after the effective date constitutes acceptance.</p>
        </Section>

        <Section title="17. Miscellaneous">
          <ul style={list}>
            <li><strong>Entire agreement:</strong> These Terms, together with our Privacy Policy and Financial Disclaimer, are the entire agreement between you and CatalystPit.</li>
            <li><strong>Severability:</strong> If any provision is found unenforceable, the remaining provisions will remain in effect.</li>
            <li><strong>No waiver:</strong> Our failure to enforce any provision does not waive our right to enforce it later.</li>
            <li><strong>Assignment:</strong> You may not assign these Terms without our written consent. We may assign these Terms freely.</li>
            <li><strong>Notices:</strong> We may send notices to the email address on your account. You may send notices to <a href="mailto:legal@catalystpit.com" style={linkStyle}>legal@catalystpit.com</a>.</li>
          </ul>
        </Section>

        <Section title="18. Contact">
          <p style={{ margin: "12px 0", fontFamily: "'DM Mono',monospace", fontSize: 13 }}>
            Email: <a href="mailto:legal@catalystpit.com" style={linkStyle}>legal@catalystpit.com</a>
          </p>
          <p style={{ margin: "12px 0", fontFamily: "'DM Mono',monospace", fontSize: 13 }}>
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
