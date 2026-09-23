'use client';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useUser, useClerk } from '@clerk/nextjs';
import { C } from '../lib/cp-tokens.mjs';
import { startCheckout } from '../lib/cp-shared';

// THE CATALYST PIT ACCOUNT MENU.
//
// ⚠️ CLERK STILL DOES ALL THE SECURITY WORK. This replaces one thing only: the prebuilt dropdown.
// Authentication, the session, sign-out, password and MFA management all remain Clerk's, reached
// through Clerk's own hosted UserProfile at /account. Nothing here implements a password field, a
// session check or a token, and nothing here decides what a reader is entitled to.
//
// ⚠️ THE TIER IS FETCHED FROM THE SERVER, NEVER READ FROM THE CLIENT SESSION. publicMetadata is
// visible to the browser and therefore editable in devtools; a badge derived from it would be a
// cosmetic lie at best and, if anything downstream trusted it, a bypass. /api/me/plan resolves
// through resolveUserAccess() server-side — the same call every gated route uses — so the badge can
// only ever be a REPORT of the entitlement, never its source.
//
// ⚠️ AND IT IS PRESENTATION ONLY. Hiding "Upgrade" from a Pro user is a UI nicety; the paywall is
// enforced server-side and is unaffected by anything in this file.

const ITEM = {
  display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px',
  fontSize: 12.5, color: C.text, textDecoration: 'none', background: 'none',
  border: 'none', cursor: 'pointer', fontFamily: 'inherit', borderRadius: 5,
};

function Item({ href, onClick, children }) {
  const hover = {
    onMouseEnter: (e) => { e.currentTarget.style.background = C.surface; },
    onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
  };
  if (href) return <a href={href} role="menuitem" style={ITEM} {...hover}>{children}</a>;
  return <button type="button" role="menuitem" onClick={onClick} style={ITEM} {...hover}>{children}</button>;
}

export default function AccountMenu() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState(null);
  const btnRef = useRef(null);
  const wrapRef = useRef(null);

  // Server-resolved entitlement. Fetched once the menu is first opened rather than on every page
  // load, so a signed-in reader who never opens it costs nothing.
  useEffect(() => {
    if (!open || tier !== null) return undefined;
    let alive = true;
    fetch('/api/me/plan', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setTier(j?.tier || 'free'); })
      .catch(() => { if (alive) setTier('free'); });
    return () => { alive = false; };
  }, [open, tier]);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { close(); btnRef.current?.focus(); } };
    // ⚠️ POINTERDOWN, NOT CLICK — a click-away listener on `click` fires after the menu item's own
    // handler on touch and can close the menu before navigation resolves.
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) close(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [open, close]);

  if (!isLoaded || !user) return null;

  const name = user.fullName || user.username || 'Account';
  const email = user.primaryEmailAddress?.emailAddress || '';
  const isPro = tier === 'pro' || tier === 'elite';
  const badge = tier === null ? '' : isPro ? (tier === 'elite' ? 'PIT ELITE' : 'PIT PRO') : 'FREE';

  const portal = async () => {
    close();
    try {
      const r = await fetch('/api/stripe/portal', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (j?.url) window.location.href = j.url; else window.location.href = '/account';
    } catch { window.location.href = '/account'; }
  };

  return (
    <span ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button ref={btnRef} type="button" onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu" aria-expanded={open} aria-label="Account menu"
        style={{
          width: 32, height: 32, borderRadius: '50%', padding: 0, cursor: 'pointer',
          border: `1px solid ${open ? C.green : C.border2}`, background: C.surface,
          overflow: 'hidden', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
        {user.imageUrl
          ? <img src={user.imageUrl} alt="" width={32} height={32} style={{ display: 'block', objectFit: 'cover' }} />
          : <span style={{ fontSize: 12, fontWeight: 800, color: C.ink }}>{(name[0] || 'A').toUpperCase()}</span>}
      </button>

      {open && (
        // ⚠️ ABSOLUTE INSIDE A relative WRAPPER, and the nav bar does not clip this one — unlike the
        // "More" menu, which sits inside the overflow:hidden links row and had to go fixed. zIndex
        // clears the header and the watchlist dock.
        <div role="menu" style={{
          position: 'absolute', top: 40, right: 0, width: 232, zIndex: 200,
          background: C.white, border: `1px solid ${C.border2}`, borderRadius: 8,
          boxShadow: '0 6px 20px rgba(0,0,0,0.14)', padding: 5,
        }}>
          <div style={{ padding: '7px 12px 9px', borderBottom: `1px solid ${C.surface}`, marginBottom: 4 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, lineHeight: 1.3 }}>{name}</div>
            {email && <div style={{ fontSize: 10.5, color: C.muted, lineHeight: 1.4, wordBreak: 'break-all' }}>{email}</div>}
            {badge && (
              <span style={{
                display: 'inline-block', marginTop: 6, fontSize: 9, fontWeight: 800,
                letterSpacing: '0.6px', padding: '2px 7px', borderRadius: 3,
                background: isPro ? C.greenLight : C.surface,
                color: isPro ? C.green : C.muted,
                border: `1px solid ${isPro ? C.green : C.border}`,
              }}>{badge}</span>
            )}
          </div>

          {/* ⚠️ ONLY DESTINATIONS THAT EXIST. /account is Clerk's own UserProfile in navigation mode,
              which is the right place for password and MFA — we do not reimplement those. There is
              no /alerts page today, so there is no Alerts entry. */}
          <Item href="/account">Account</Item>
          <Item href="/watchlist">Watchlist</Item>
          <Item href="/settings">Settings</Item>
          {tier !== null && (isPro
            ? <Item onClick={portal}>Billing</Item>
            : <Item onClick={() => { close(); startCheckout(); }}>Upgrade to Pit Pro</Item>)}

          <div style={{ borderTop: `1px solid ${C.surface}`, marginTop: 4, paddingTop: 4 }}>
            <Item onClick={() => { close(); signOut({ redirectUrl: '/' }); }}>Sign out</Item>
          </div>
        </div>
      )}
    </span>
  );
}
