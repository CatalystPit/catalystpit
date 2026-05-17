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
  navBg: "#1E5C38",
};

export default function ContactPage() {
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

      {/* FOOTER */}
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

const footerLink = { fontSize: 12, color: "rgba(255,255,255,0.6)", textDecoration: "none", fontWeight: 300 };
