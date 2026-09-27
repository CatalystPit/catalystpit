'use client';
import { UserProfile } from '@clerk/nextjs';
import { C, BrandStyles, Logo, Footer, useTheme } from '../../lib/cp-shared';
import AccountBilling from '../../components/AccountBilling';
import { clerkAppearance } from '../../lib/clerk-appearance.mjs';

export default function AccountPage() {
  // ⚠️ CLERK IS THE ONE THING ON THIS PAGE THAT CANNOT THEME ITSELF. Everything else here styles
  // with `C.x`, which are CSS-variable strings the browser re-resolves when data-theme flips.
  // Clerk parses colours numerically and ignores `var(...)`, so it needs literal hex handed to it
  // per theme — and handed again whenever the theme changes. See lib/clerk-appearance.mjs.
  const theme = useTheme();

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, minHeight: "100vh" }}>
      <BrandStyles/>
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
        {/* ⚠️ KEYED ON THE THEME. Clerk memoises heavily off its appearance prop; remounting on a
            theme flip is the cheap way to guarantee every already-rendered subview — an open
            Security page, a form mid-edit — picks up the new palette rather than half of it. */}
        <UserProfile key={theme} appearance={clerkAppearance(theme)} />
      </div>
      <Footer/>
    </div>
  );
}
