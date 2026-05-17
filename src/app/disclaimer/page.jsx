'use client';
import { useEffect } from 'react';

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
  red: "#A83030",
  redLight: "#FAEAEA",
  navBg: "#1E5C38",
};

export default function DisclaimerPage() {
  useEffect(() => {
    const fl = document.createElement("link");
    fl.rel = "stylesheet";
    fl.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,600;1,600&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600;700&display=swap";
    document.head.appendChild(fl);
  }, []);

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, minHeight: "100vh", color: C.text }}>
      {/* NAV */}
      <div style={{
        background: C.navBg, height: 50, display: "flex", alignItems: "center",
        justifyContent: "space-between", padding: "0 24px", position: "sticky", top: 0, zIndex: 100,
        borderBottom: "1px solid rgba(255,255,255,0.15)"
      }}>
        <a href="/" style={{ textDecoration: "none", lineHeight: 1.05, cursor: "pointer" }}>
          <span style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 20, fontWeight: 300, color: "#FFFFFF", letterSpacing: "0.04em" }}>Catalyst</span>
          <span style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 20, fontWeight: 600, fontStyle: "italic", color: "#5AB87A", letterSpacing: "0.02em" }}>Pit</span>
        </a>
        <a href="/" style={{ fontSize: 12, color: "rgba(255,255,255,0.75)", textDecoration: "none", fontWeight: 300 }}>← Back to homepage</a>
      </div>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px 64px" }}>
        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, color: C.muted, letterSpacing: "1.5px", marginBottom: 12 }}>
          LEGAL
        </div>
        <h1 style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 34, fontWeight: 700, color: C.ink, margin: "0 0 8px", letterSpacing: "-0.5px", lineHeight: 1.15 }}>
          Financial Disclaimer
        </h1>
        <p style={{ fontSize: 13, color: C.muted, margin: "0 0 24px", fontWeight: 300 }}>
          Effective date: May 17, 2026 · Last updated: May 17, 2026
        </p>

        <div style={{ background: C.redLight, border: `1px solid ${C.red}`, borderRadius: 8, padding: "18px 20px", margin: "0 0 36px" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.red, marginBottom: 8, letterSpacing: "-0.2px" }}>
            ⚠ Read this before using CatalystPit for any trading or investment decision.
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.6, color: "#5A1A1A" }}>
            CatalystPit is an informational and educational service. We are not a registered investment advisor, broker-dealer, or financial planner. Nothing on this site, in our newsletter, or in any related communications is investment advice, financial advice, or a recommendation to buy, sell, or hold any security or asset.
          </div>
        </div>

        <Section title="1. Not Investment Advice">
          <p>All content on CatalystPit — including market data, news summaries, AI-generated analysis, insider trading filings, congressional trading disclosures, options flow, short interest, and any commentary — is provided for informational and educational purposes only.</p>
          <p>Nothing on CatalystPit constitutes:</p>
          <ul style={list}>
            <li>Investment advice or a recommendation to buy, sell, or hold any security, derivative, cryptocurrency, or other asset</li>
            <li>An offer or solicitation to buy or sell any financial instrument</li>
            <li>Financial planning, tax advice, legal advice, or accounting advice</li>
            <li>A guarantee of any specific outcome, return, or performance</li>
          </ul>
          <p>You should consult a licensed financial advisor, broker, tax professional, or attorney before making any investment or financial decision.</p>
        </Section>

        <Section title="2. We Are Not a Registered Advisor">
          <p>CatalystPit and its operator are not registered as an investment advisor with the U.S. Securities and Exchange Commission (SEC), any state securities regulator, the Commodity Futures Trading Commission (CFTC), the Financial Industry Regulatory Authority (FINRA), or any equivalent body in any jurisdiction. We do not provide personalized investment advice.</p>
          <p>Any opinions expressed are those of the operator and represent commentary on publicly available information, not advice tailored to any individual's financial situation, objectives, risk tolerance, or needs.</p>
        </Section>

        <Section title="3. Risk Warning">
          <p style={{ fontWeight: 600, color: C.ink }}>Trading and investing involve substantial risk of loss, including the loss of all invested capital.</p>
          <ul style={list}>
            <li><strong>Stocks and ETFs:</strong> Past performance does not guarantee future results. Stock prices can fall as well as rise, and you may lose more than you originally invested in some products.</li>
            <li><strong>Options:</strong> Options trading involves significant risk and is not suitable for all investors. Options can expire worthless, and certain strategies can lead to losses exceeding the initial investment.</li>
            <li><strong>Futures and derivatives:</strong> Highly leveraged. Small market movements can produce disproportionately large gains or losses. You can lose more than your initial deposit.</li>
            <li><strong>Cryptocurrencies:</strong> Extremely volatile. Largely unregulated. Vulnerable to fraud, hacks, technical failures, and total loss of value.</li>
            <li><strong>Short selling and margin:</strong> Theoretically unlimited losses. Margin calls can force liquidation at unfavorable prices.</li>
          </ul>
          <p>Only invest money you can afford to lose. Never trade with borrowed money you cannot afford to repay. Past performance of any security, strategy, or market is not indicative of future results.</p>
        </Section>

        <Section title="4. Data Accuracy and Sources">
          <p>CatalystPit aggregates data from third-party sources including Polygon.io, GNews, the U.S. Securities and Exchange Commission (SEC EDGAR), CoinGecko, and others. While we make reasonable efforts to present accurate and timely information, we do not guarantee that any data is accurate, complete, current, or free from errors or omissions.</p>
          <ul style={list}>
            <li><strong>Delayed data:</strong> Market prices may be delayed by up to 15 minutes or more depending on the data feed and tier in use.</li>
            <li><strong>Third-party errors:</strong> Errors in third-party data are outside our control.</li>
            <li><strong>AI-generated content:</strong> Some content is generated or summarized by artificial intelligence. AI can make mistakes, generate inaccurate or misleading statements, or misinterpret source material. Do not rely on AI-generated content for any decision without independent verification.</li>
            <li><strong>SEC filings:</strong> Form 4 insider filings and other SEC disclosures may be filed days after the underlying transaction. Filing data does not represent real-time trading activity.</li>
            <li><strong>Congressional trades:</strong> Senate and House disclosures are reported with delays of up to 45 days under the STOCK Act and may not reflect current positions.</li>
          </ul>
          <p>You are responsible for verifying any information through independent sources, including the actual SEC filings, before relying on it.</p>
        </Section>

        <Section title="5. No Guarantee of Results">
          <p>No statement on CatalystPit — explicit or implied — is a guarantee of any trading, investment, or financial result. Hypothetical or historical examples are not predictions of future outcomes. Any reference to past gains, returns, or successful trades does not imply that similar results will occur in the future or for any individual user.</p>
        </Section>

        <Section title="6. Conflicts of Interest">
          <p>The operator of CatalystPit may hold positions in securities, derivatives, cryptocurrencies, or other assets discussed on the Service. These positions may change at any time without notice. The operator may buy, sell, or hold any security mentioned before, during, or after publication of related content.</p>
          <p>CatalystPit may receive affiliate compensation or referral fees from third-party services mentioned on the Service. This does not influence the editorial content but should be considered a potential conflict of interest.</p>
          <p>If CatalystPit launches paid subscription tiers, our economic interest is in retaining subscribers, which may create incentives to publish engaging rather than purely objective content. Readers should evaluate content critically.</p>
        </Section>

        <Section title="7. No Fiduciary Relationship">
          <p>Your use of CatalystPit does not create any advisor-client, fiduciary, or similar professional relationship between you and CatalystPit or its operator. We owe you no duty of care, loyalty, or due diligence beyond what these Terms and the Privacy Policy expressly state.</p>
        </Section>

        <Section title="8. Forward-Looking Statements">
          <p>Content on CatalystPit may include forward-looking statements about markets, companies, economies, or events. These statements involve known and unknown risks, uncertainties, and assumptions. Actual outcomes may differ materially. We undertake no obligation to update forward-looking statements.</p>
        </Section>

        <Section title="9. Jurisdictional Limitations">
          <p>CatalystPit is operated from the United States. Content may not be appropriate or legal in all jurisdictions. By using the Service, you represent that doing so does not violate the laws of your jurisdiction. You are responsible for complying with all applicable laws, including securities laws and tax laws in your jurisdiction.</p>
        </Section>

        <Section title="10. Your Responsibility">
          <p>By using CatalystPit, you acknowledge and agree that:</p>
          <ul style={list}>
            <li>You are solely responsible for your investment and trading decisions</li>
            <li>You will not hold CatalystPit, its operator, agents, or licensors liable for any losses, damages, or costs resulting from your use of the Service or any decisions made based on Service content</li>
            <li>You will conduct your own due diligence and consult licensed professionals before making any financial decision</li>
            <li>You understand the risks of trading and investing and accept full responsibility for outcomes</li>
          </ul>
        </Section>

        <Section title="11. Contact">
          <p style={{ margin: "12px 0", fontFamily: "'DM Mono',monospace", fontSize: 13 }}>
            Email: <a href="mailto:legal@catalystpit.com" style={linkStyle}>legal@catalystpit.com</a>
          </p>
          <p style={{ margin: "12px 0", fontFamily: "'DM Mono',monospace", fontSize: 13 }}>
            CatalystPit<br/>
            Florida, United States
          </p>
        </Section>
      </div>

      <div style={{ background: C.navBg, padding: "24px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <a href="/" style={{ textDecoration: "none", lineHeight: 1.05 }}>
          <span style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 17, fontWeight: 300, color: "#FFFFFF" }}>Catalyst</span>
          <span style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 17, fontWeight: 600, fontStyle: "italic", color: "#5AB87A" }}>Pit</span>
        </a>
        <div style={{ display: "flex", gap: 24 }}>
          <a href="/privacy" style={footerLink}>Privacy</a>
          <a href="/terms" style={footerLink}>Terms</a>
          <a href="/disclaimer" style={footerLink}>Disclaimer</a>
        </div>
        <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, color: "rgba(255,255,255,0.5)" }}>2026 CATALYSTPIT · NOT FINANCIAL ADVICE</span>
      </div>
    </div>
  );
}

const list = { margin: "12px 0", paddingLeft: 24, fontSize: 14, lineHeight: 1.7, color: C.text };
const linkStyle = { color: C.green, textDecoration: "none", fontWeight: 500 };
const footerLink = { fontSize: 12, color: "rgba(255,255,255,0.6)", textDecoration: "none", fontWeight: 300 };

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
