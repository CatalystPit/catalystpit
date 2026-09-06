'use client';
import { UserProfile } from '@clerk/nextjs';
import { Logo, Footer } from '../../lib/cp-shared';
import AccountBilling from '../../components/AccountBilling';
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
export default function AccountPage() {
  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, minHeight: "100vh" }}>
      {/* NAV */}
      <div style={{
        background: C.navBg, height: 50, display: "flex", alignItems: "center",
        justifyContent: "space-between", padding: "0 24px", position: "sticky", top: 0, zIndex: 100,
        borderBottom: "1px solid rgba(255,255,255,0.15)"
      }}>
        <a href="/" style={{ textDecoration: "none" }}><Logo dark/></a>
        <a href="/" style={{
          fontSize: 12, color: "rgba(255,255,255,0.75)",
          textDecoration: "none", fontWeight: 300
        }}>← Back to homepage</a>
      </div>
      {/* PAGE HEADER */}
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "32px 24px 16px" }}>
        <h1 style={{
          fontFamily: "'DM Sans',sans-serif", fontSize: 26, fontWeight: 700,
          color: C.ink, margin: "0 0 6px", letterSpacing: "-0.3px"
        }}>
          Account Settings
        </h1>
        <p style={{ fontSize: 14, color: C.muted, margin: 0, fontWeight: 300 }}>
          Manage your profile, security, and sessions.
        </p>
      </div>
      {/* BILLING / PLAN */}
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "16px 24px 0" }}>
        <AccountBilling />
      </div>

      {/* CLERK USER PROFILE */}
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "16px 24px 48px" }}>
        <UserProfile
          appearance={{
            elements: {
              rootBox: { width: "100%" },
              card: {
                background: C.white,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                boxShadow: "none",
              },
              navbar: { background: C.surface },
              headerTitle: {
                fontFamily: "'DM Sans',sans-serif",
                color: C.ink,
              },
              profileSectionPrimaryButton: {
                background: C.green,
                color: "#FFFFFF",
                '&:hover': { background: C.greenMid },
              },
              formButtonPrimary: {
                background: C.green,
                color: "#FFFFFF",
                '&:hover': { background: C.greenMid },
                textTransform: "none",
                fontFamily: "'DM Sans',sans-serif",
                fontWeight: 500,
              },
            },
            variables: {
              colorPrimary: C.green,
              fontFamily: "'DM Sans',sans-serif",
            },
          }}
        />
      </div>
      <Footer/>
    </div>
  );
}
