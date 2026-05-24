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

export default function ContactPage() {
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

      {/* HEADER */}
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px 16px" }}>
        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, color: C.muted, letterSpacing: "1.5px", marginBottom: 12 }}>
          GET IN TOUCH
        </div>
        <h1 style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 34, fontWeight: 700, color: C.ink, margin: "0 0 8px", letterSpacing: "-0.5px", lineHeight: 1.15 }}>
          Contact us
        </h1>
        <p style={{ fontSize: 15, color: C.muted, margin: "0 0 24px", fontWeight: 300, lineHeight: 1.5 }}>
          Questions, feedback, press inquiries, or partnership ideas — drop us a message and we'll respond within 1-2 business days.
        </p>
      </div>

      {/* FORM EMBED */}
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "8px 24px 48px" }}>
        <div style={{
          background: C.white,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          overflow: "hidden",
        }}>
          <iframe
            src="https://docs.google.com/forms/d/e/1FAIpQLSflaDPmi_p-Gmb5VgNMbcZVciw0yNWk4uG0txoWa-xjHiwtFQ/viewform?embedded=true"
            width="100%"
            height="1109"
            frameBorder="0"
            marginHeight="0"
            marginWidth="0"
            style={{ display: "block", border: "none" }}
          >
            Loading…
          </iframe>
        </div>

        <p style={{ fontSize: 12, color: C.muted, marginTop: 16, fontWeight: 300, textAlign: "center" }}>
          Form processed by Google. Submissions are emailed to our team and securely stored.
        </p>
      </div>

      <Footer/>
    </div>
  );
}

