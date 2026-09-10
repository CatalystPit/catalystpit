'use client';
import { C, BrandStyles, Logo, Footer } from '../../lib/cp-shared';

export default function PrivacyPage() {
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

      {/* CONTENT */}
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px 64px" }}>
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.muted, letterSpacing: "1.5px", marginBottom: 12 }}>
          LEGAL
        </div>
        <h1 style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 34, fontWeight: 700, color: C.ink, margin: "0 0 8px", letterSpacing: "-0.5px", lineHeight: 1.15 }}>
          Privacy Policy
        </h1>
        <p style={{ fontSize: 13, color: C.muted, margin: "0 0 40px", fontWeight: 300 }}>
          Effective date: May 17, 2026 · Last updated: May 17, 2026
        </p>

        <Section title="1. Who We Are">
          <p>CatalystPit ("CatalystPit," "we," "us," or "our") is a financial intelligence platform operated by Benjamin Coghill, based in Edgewater, Florida, United States. We provide real-time market data, news enrichment, and trading-related content via our website at catalystpit.com (the "Service") and our newsletter "The Catalyst Brief."</p>
          <p>This Privacy Policy explains what data we collect, how we use it, who we share it with, and the rights you have over your data.</p>
        </Section>

        <Section title="2. Information We Collect">
          <h3 style={subhead}>2.1 Information you give us directly</h3>
          <ul style={list}>
            <li><strong>Account information:</strong> When you sign up, we collect your name, email address, and password (managed by our authentication provider Clerk). If you sign up via Google, we receive your name, email, and profile picture from Google.</li>
            <li><strong>Newsletter signups:</strong> If you subscribe to The Catalyst Brief, we collect your email address via our newsletter provider Beehiiv.</li>
            <li><strong>Payment information (future):</strong> When paid subscription tiers become available, payment details (card number, billing address) will be collected and processed by Stripe. CatalystPit does not store or have direct access to your full payment card information.</li>
            <li><strong>Communications:</strong> If you contact us by email or other means, we receive whatever information you choose to share.</li>
          </ul>

          <h3 style={subhead}>2.2 Information collected automatically</h3>
          <ul style={list}>
            <li><strong>Usage data:</strong> We may collect technical information such as your IP address, browser type, device type, pages visited, and timestamps via our hosting provider (Vercel). We plan to add Vercel Analytics, which collects aggregated, anonymized usage data and does not use cookies.</li>
            <li><strong>Cookies and similar technologies:</strong> Our authentication provider Clerk uses cookies to keep you signed in. We do not currently use advertising or third-party tracking cookies.</li>
          </ul>

          <h3 style={subhead}>2.3 Information from third parties</h3>
          <p>We do not currently purchase or receive personal data about you from third parties beyond what is necessary to deliver our Service (e.g., Google authentication data when you sign in with Google).</p>
        </Section>

        <Section title="3. How We Use Your Information">
          <p>We use the information we collect to:</p>
          <ul style={list}>
            <li>Create and maintain your account</li>
            <li>Deliver the Service, including personalized features as they launch</li>
            <li>Send you transactional emails (account verification, password resets, subscription confirmations)</li>
            <li>Send you newsletters and marketing communications you have opted into (you may unsubscribe at any time)</li>
            <li>Process payments and manage subscriptions (when paid tiers launch)</li>
            <li>Detect, prevent, and respond to fraud, abuse, or technical issues</li>
            <li>Comply with legal obligations</li>
            <li>Improve and develop the Service</li>
          </ul>
          <p>We do not sell your personal information to third parties.</p>
        </Section>

        <Section title="4. How We Share Your Information">
          <p>We share your information only as described below:</p>
          <ul style={list}>
            <li><strong>Service providers:</strong> We use third-party providers to operate the Service. Each receives only the information needed to perform its function. These include:
              <ul style={listInner}>
                <li>Clerk (authentication and user management)</li>
                <li>Beehiiv (newsletter delivery)</li>
                <li>Vercel (website hosting and infrastructure)</li>
                <li>Upstash (data caching)</li>
                <li>Anthropic (AI-powered content enrichment — no personal data is sent)</li>
                <li>Stripe (payment processing, when paid tiers launch)</li>
                <li>Finnhub, SEC EDGAR, CoinGecko, and news feeds from The Wall Street Journal, MarketWatch and Bloomberg (market data sources — no personal data is sent)</li>
              </ul>
            </li>
            <li><strong>Legal requirements:</strong> We may disclose information if required by law, subpoena, court order, or similar legal process, or if we believe disclosure is necessary to protect our rights, your safety, or the safety of others.</li>
            <li><strong>Business transfers:</strong> If CatalystPit is acquired, merged, or sells assets, your information may be transferred as part of that transaction. We will notify you before your information becomes subject to a different privacy policy.</li>
          </ul>
        </Section>

        <Section title="5. Data Retention">
          <p>We retain your account information for as long as your account is active. If you delete your account, we will delete or anonymize your personal information within 30 days, except where we are required to retain it for legal, tax, or security purposes.</p>
          <p>Newsletter subscriber emails are retained until you unsubscribe. Unsubscribe at any time using the link in any newsletter or by contacting us.</p>
        </Section>

        <Section title="6. Security">
          <p>We use industry-standard measures to protect your information, including encrypted connections (HTTPS), encrypted password storage via Clerk, and access controls on our infrastructure. No system is perfectly secure, however, and we cannot guarantee absolute security. If we become aware of a data breach affecting your personal information, we will notify you as required by applicable law.</p>
        </Section>

        <Section title="7. Your Rights">
          <p>Depending on where you live, you may have the following rights regarding your personal information:</p>
          <ul style={list}>
            <li><strong>Access:</strong> Request a copy of the personal information we hold about you.</li>
            <li><strong>Correction:</strong> Request that we correct inaccurate information.</li>
            <li><strong>Deletion:</strong> Request that we delete your personal information.</li>
            <li><strong>Opt-out of marketing:</strong> Unsubscribe from newsletters at any time.</li>
            <li><strong>Data portability:</strong> Request a portable copy of your data.</li>
            <li><strong>Withdraw consent:</strong> Where we rely on consent, you may withdraw it at any time.</li>
          </ul>
          <p><strong>California residents:</strong> Under the CCPA/CPRA, you have additional rights including the right to know what categories of information we collect, the right to delete, and the right to non-discrimination for exercising your rights. We do not sell or share personal information in the sense defined by the CCPA.</p>
          <p><strong>EU/UK residents:</strong> Under the GDPR and UK GDPR, you have the rights listed above plus the right to lodge a complaint with your local data protection authority. The legal bases on which we process your data include contract performance, legitimate interests, consent, and legal obligations.</p>
          <p>To exercise any of these rights, contact us at the email address below. We will respond within the timeframes required by applicable law.</p>
        </Section>

        <Section title="8. Children's Privacy">
          <p>CatalystPit is not directed to children under 18, and we do not knowingly collect personal information from anyone under 18. If you believe we have collected information from a minor, please contact us and we will delete it.</p>
        </Section>

        <Section title="9. International Users">
          <p>CatalystPit is operated from the United States. If you access the Service from outside the U.S., your information will be transferred to, stored, and processed in the United States. By using the Service, you consent to this transfer.</p>
        </Section>

        <Section title="10. Changes to This Policy">
          <p>We may update this Privacy Policy from time to time. The "Last updated" date at the top reflects the most recent changes. For significant changes, we will notify you by email or through a notice on the Service before the changes take effect.</p>
        </Section>

        <Section title="11. Contact">
          <p>Questions about this Privacy Policy or our data practices? Contact us at:</p>
          <p style={{ margin: "12px 0", fontFamily: "'DM Sans',sans-serif", fontSize: 13 }}>
            Email: <a href="mailto:privacy@catalystpit.com" style={linkStyle}>privacy@catalystpit.com</a>
          </p>
          <p style={{ margin: "12px 0", fontFamily: "'DM Sans',sans-serif", fontSize: 13 }}>
            CatalystPit<br/>
            Florida, United States
          </p>
        </Section>
      </div>

      <Footer/>
    </div>
  );
}

const subhead = { fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 600, color: C.ink, margin: "20px 0 10px" };
const list = { margin: "12px 0", paddingLeft: 24, fontSize: 14, lineHeight: 1.7, color: C.text };
const listInner = { margin: "8px 0", paddingLeft: 22, fontSize: 14, lineHeight: 1.6, color: C.muted };
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
