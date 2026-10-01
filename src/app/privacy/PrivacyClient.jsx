'use client';
import { C, BrandStyles, Logo, Footer } from '../../lib/cp-shared';

export default function PrivacyClient() {
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
          Effective date: May 17, 2026 · Last updated: September 30, 2026
        </p>

        <Section title="1. Who We Are">
          <p>CatalystPit ("CatalystPit," "we," "us," or "our") is a financial intelligence platform operated by Benjamin Coghill, based in Edgewater, Florida, United States. We provide market data, news enrichment, and trading-related content via our website at catalystpit.com (the "Service") and our newsletter "The Catalyst Brief." The freshness of market data shown to you depends on your subscription tier, the source, and our licensing for that data — some views are real-time, others are delayed or reflect the last completed session, and each surface labels which it is showing.</p>
          <p>This Privacy Policy explains what data we collect, how we use it, who we share it with, and the rights you have over your data.</p>
        </Section>

        <Section title="2. Information We Collect">
          <h3 style={subhead}>2.1 Information you give us directly</h3>
          <ul style={list}>
            <li><strong>Account information:</strong> When you sign up, we collect your name, email address, and password (managed by our authentication provider Clerk). If you sign up via Google, we receive your name, email, and profile picture from Google.</li>
            <li><strong>Newsletter signups:</strong> If you subscribe to The Catalyst Brief, we collect your email address via our newsletter provider Beehiiv.</li>
            <li><strong>Payment and subscription information:</strong> Paid subscriptions are processed by Stripe. Stripe collects your payment details (card number, billing address) directly — <strong>CatalystPit never receives or stores your full payment card information.</strong> What we hold is the subscription relationship: your plan status (free, Pro or Elite) and a Stripe customer identifier, stored against your account so we know what you are entitled to.</li>
            <li><strong>Public profile:</strong> If you use The Pit (our community), you may create a public profile containing a handle, display name, bio, avatar image and optional links to your X and Instagram accounts, plus a setting controlling whether your watchlist is publicly visible. Anything you put here is visible to other users.</li>
            <li><strong>Content you post:</strong> Messages, posts, comments, reactions, likes, follows and reports you submit in The Pit and the Feed.</li>
            <li><strong>Watchlists and alerts:</strong> The tickers you add to watchlists (including named lists and your ordering), the tickers you have enabled Evidence Alerts on, and the alerts generated for you together with their read/unread state.</li>
            <li><strong>Product preferences:</strong> Saved Terminal workspace layouts and similar settings stored against your account.</li>
            <li><strong>Communications:</strong> If you contact us by email or through our contact form (hosted by Google Forms), we receive whatever information you choose to share.</li>
          </ul>

          <h3 style={subhead}>2.2 Information collected automatically</h3>
          <ul style={list}>
            <li><strong>Usage data:</strong> We may collect technical information such as your IP address, browser type, device type, pages visited, and timestamps via our hosting provider (Vercel).</li>
            <li><strong>IP address for security:</strong> The Service reads the IP address of incoming requests to apply rate limiting and to protect against abuse of our APIs. It is used for that purpose and is not used to build an advertising or tracking profile.</li>
            {/* ⚠️ THE CATEGORIES ARE NAMED because which ones are in use is what decides whether a
                consent banner is legally required — and the answer changed. This said the storage in
                play was only strictly-necessary and functional, "which is why there is no banner", and
                reasoned from that to not asking for consent. Measured from a clean profile on live
                production, two page views now leave a .doubleclick.net "IDE" cookie in the jar with no
                advertisement filled, so the premise is false and the inference drawn from it with it.
                What remains true is the narrower claim: WE set only those two kinds. The advertising
                cookies are the vendors' own, which is section 2.4's subject. */}
            <li><strong>Cookies and browser storage:</strong> We ourselves set two kinds of browser
              storage, and only two. <strong>Strictly necessary:</strong> our authentication provider Clerk sets
              cookies to keep you signed in and to protect the sign-in process — without these the
              Service cannot log you in. <strong>Functional:</strong> we store display preferences in
              your browser's local storage — chart settings, indicators, drawings, Terminal layout,
              light or dark mode and similar choices. That data stays in your browser, is readable only
              by this site, and is not a tracking mechanism.
              <br />
              <strong>We do not set advertising or cross-site tracking cookies ourselves.</strong>{" "}
              Third-party advertising partners, including Google, may set and read their own cookies or
              similar technologies in your browser in connection with advertising on the Service. Where
              the law requires your consent before advertising or similar non-essential cookies are set,
              we will obtain it — see section 2.4.</li>
            {/* ⚠️ THE POLICY SAID "we do not run an analytics package" UNTIL WE RAN ONE. Web Analytics
                shipped for launch monitoring, so that sentence had to go the same day — it is the
                identical failure this section already carries a scar from with the ad loader. What
                replaces it is specific about which product and, more usefully, about what it does NOT
                do, because "we use analytics" tells a reader nothing about their exposure. */}
            <li><strong>Analytics:</strong> We use <strong>Vercel Web Analytics</strong>, provided by our
              hosting provider, to understand how the Service is used — page views, which pages people
              land on, the referring site, approximate location at country level, and device and browser
              type. <strong>It sets no cookies, assigns you no persistent identifier, and does not track
              you across other websites.</strong> It does not record your name, email address or account
              details, and we do not use it for advertising. We do not use session replay, fingerprinting
              or any form of individual behavioural tracking.</li>
          </ul>

          <h3 style={subhead}>2.3 Information from third parties</h3>
          <p>We do not currently purchase or receive personal data about you from third parties beyond what is necessary to deliver our Service (e.g., Google authentication data when you sign in with Google).</p>

          <h3 style={subhead}>2.4 Advertising</h3>
          {/* ⚠️ THIS SECTION HAS NOW BEEN WRONG IN BOTH DIRECTIONS, WHICH IS WHY IT IS WORDED THIS WAY.
              It first overstated ("Advertising may be displayed to you") while only a verification
              loader shipped. It was corrected to "We do not currently display advertising… no
              advertising cookies are set by us" — accurate that day, and false once the loader began
              requesting placements, because Google's auto-ads inject the slot at runtime and a
              .doubleclick.net cookie is now set on a first visit with nothing filled.

              A privacy policy that overstates tracking is as wrong as one that understates it, and this
              is the claim a regulator reads first. So the wording no longer turns on whether a
              particular placement happens to be filled — that is the fact that kept changing underneath
              it without a deployment. */}
          <p style={{ fontWeight: 600 }}>
            The Service may display advertising provided by third-party advertising partners, including
            Google AdSense.
          </p>
          <p>
            Google AdSense is integrated on Catalyst Pit. Whether an advertisement appears in a given
            placement, at a given time, is determined by Google rather than by us, so you may or may not
            see advertising on any particular visit. Google and its partners may set and read their own
            cookies or similar technologies in your browser in connection with advertising on the
            Service, whether or not an advertisement is displayed to you.
          </p>
          <p><strong>How advertising works on the Service:</strong></p>
          <ul style={list}>
            <li><strong>Who sees ads:</strong> Advertising will be shown to logged-out visitors and to
              signed-in users on the Free tier. <strong>Catalyst Pit Pro subscribers will not be shown
              advertising.</strong></li>
            <li><strong>Consent:</strong> Where the law requires your consent before advertising or
              similar non-essential cookies are set — including in the EU, the UK and other regions with
              equivalent rules — we will ask for it before those cookies are used, and you will be able
              to change your choice afterwards.</li>
            <li><strong>Third-party advertising cookies:</strong> Third-party vendors, including Google, may use cookies or similar technologies on the Service in connection with advertising. These are set by those vendors, not by us, and we do not control them.</li>
            <li><strong>How Google may use them:</strong> Google may use advertising cookies to serve ads based on your visits to Catalyst Pit and, where applicable, to other websites. Google's use of advertising cookies enables it and its partners to serve ads to you based on those visits.</li>
            <li><strong>Your choices:</strong> You can manage or opt out of personalized advertising from Google through Google's own advertising settings at <a href="https://adssettings.google.com" target="_blank" rel="noopener noreferrer" style={linkStyle}>adssettings.google.com</a>. Google describes how it uses information from sites that use its services at <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener noreferrer" style={linkStyle}>policies.google.com/technologies/partner-sites</a>. You can also opt out of personalized advertising from participating vendors at <a href="https://optout.aboutads.info" target="_blank" rel="noopener noreferrer" style={linkStyle}>optout.aboutads.info</a>. Your browser's settings may additionally let you block or delete cookies.</li>
            <li><strong>Other advertising vendors:</strong> We may in future use other third-party advertising vendors or networks. Where we do, those vendors may likewise use cookies or similar technologies in connection with advertising on the Service.</li>
            <li><strong>What we do not do:</strong> We do not provide your name, email address or account details to advertising vendors, and we do not use the IP address we read for rate limiting to build an advertising profile.</li>
          </ul>
        </Section>

        <Section title="3. How We Use Your Information">
          <p>We use the information we collect to:</p>
          <ul style={list}>
            <li>Create and maintain your account</li>
            <li>Deliver the Service, including personalized features as they launch</li>
            <li>Send you transactional emails (account verification, password resets, subscription confirmations)</li>
            <li>Send you newsletters and marketing communications you have opted into (you may unsubscribe at any time)</li>
            <li>Process payments, manage subscriptions and apply your entitlements</li>
            <li>Operate community features, including displaying your public profile and the content you post</li>
            <li>Detect, prevent, and respond to fraud, abuse, or technical issues</li>
            <li>Comply with legal obligations</li>
            <li>Improve and develop the Service</li>
          </ul>
          <p>We do not sell your personal information to third parties.</p>
        </Section>

        <Section title="4. How We Share Your Information">
          <p>We share your information only as described below:</p>
          <ul style={list}>
            <li><strong>Service providers:</strong> We use third-party providers to operate the Service. Each receives only the information needed to perform its function. The providers that handle user information are:
              <ul style={listInner}>
                <li><strong>Clerk</strong> — authentication, account and user management</li>
                <li><strong>Stripe</strong> — payment processing and subscription billing, including the customer portal you use to manage or cancel</li>
                <li><strong>Neon</strong> — the managed PostgreSQL database that stores your watchlists, alert subscriptions and alerts, public profile, community content and saved preferences</li>
                <li><strong>Vercel</strong> — website hosting and infrastructure, including file storage for uploaded images such as avatars, and cookieless Web Analytics as described in section 2.2</li>
                <li><strong>Upstash</strong> — caching and short-lived operational data</li>
                <li><strong>Ably</strong> — realtime message delivery for The Pit, so chat and presence reach other users live</li>
                <li><strong>Resend</strong> — delivery of transactional and alert emails we send to your address</li>
                <li><strong>Beehiiv</strong> — newsletter delivery for The Catalyst Brief</li>
                <li><strong>Google Forms</strong> — hosts our contact form and receives what you submit through it</li>
              </ul>
            </li>
            <li><strong>Content and market-data vendors:</strong> We obtain market data, filings and news from third parties including Tiingo, the U.S. Securities and Exchange Commission (SEC EDGAR), FINRA, Nasdaq Trader, official congressional disclosure sources and various news and press-release feeds, and we use Anthropic to enrich and summarise that content. <strong>These vendors do not receive your personal information</strong> — we request data about securities and companies, not about you.</li>
            <li><strong>Advertising vendors:</strong> <strong>The Service may display advertising provided by third-party advertising partners, including Google AdSense.</strong> We do not send Google your name, email address or account details. Google and its partners may set and read their own cookies in your browser, as described in section 2.4. Pro subscribers will not be shown advertising.</li>
            <li><strong>Legal requirements:</strong> We may disclose information if required by law, subpoena, court order, or similar legal process, or if we believe disclosure is necessary to protect our rights, your safety, or the safety of others.</li>
            <li><strong>Business transfers:</strong> If CatalystPit is acquired, merged, or sells assets, your information may be transferred as part of that transaction. We will notify you before your information becomes subject to a different privacy policy.</li>
          </ul>
        </Section>

        <Section title="5. Data Retention">
          <p>We retain your account information for as long as your account is active. If you delete your account, we will delete or anonymize your personal information within 30 days, except where we are required to retain it for legal, tax, or security purposes.</p>
          <p>Newsletter subscriber emails are retained until you unsubscribe. Unsubscribe at any time using the link in any newsletter or by contacting us.</p>
          <p>Content you posted publicly in The Pit may remain visible after you delete your account where other users' conversations depend on it; contact us if you need specific posts removed. Alerts generated for you are pruned automatically — read alerts after 30 days, unread alerts after 90.</p>
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
