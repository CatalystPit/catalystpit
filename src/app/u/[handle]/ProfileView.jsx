'use client';

import { useEffect, useState } from 'react';
import { C, BrandStyles, TopNav, Footer, TickerLogo } from '../../../lib/cp-shared';

const CASHTAG_RE = /\$[A-Za-z]{1,5}\b/g;
function Body({ text }) {
  const parts = []; let last = 0, m; CASHTAG_RE.lastIndex = 0;
  while ((m = CASHTAG_RE.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const sym = m[0].slice(1).toUpperCase();
    parts.push(<a key={m.index} href={`/ticker/${sym}`} style={{ color: C.green, fontWeight: 600, textDecoration: 'none' }}>{m[0].toUpperCase()}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

const fmtDate = (ts) => { try { return new Date(ts).toLocaleDateString([], { year: 'numeric', month: 'long' }); } catch { return ''; } };
const fmtTime = (ts) => { try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

export default function ProfileView({ handle }) {
  const [state, setState] = useState('loading'); // loading | ok | notfound
  const [p, setP] = useState(null);
  const [isOwn, setIsOwn] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [following, setFollowing] = useState(false);
  const [followers, setFollowers] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pubRes, meRes] = await Promise.all([
          fetch(`/api/profile?handle=${encodeURIComponent(handle)}`, { cache: 'no-store' }),
          fetch('/api/profile', { cache: 'no-store' }).catch(() => null),
        ]);
        if (cancelled) return;
        if (!pubRes.ok) { setState('notfound'); return; }
        const j = await pubRes.json();
        setP(j.profile); setState('ok');
        setFollowing(!!j.profile.isFollowing);
        setFollowers(j.profile.followers || 0);
        setFollowingCount(j.profile.following || 0);
        if (meRes && meRes.ok) {
          setLoggedIn(true);
          const mj = await meRes.json();
          if (mj?.profile?.handle && mj.profile.handle === j.profile.handle) setIsOwn(true);
        }
      } catch { if (!cancelled) setState('notfound'); }
    })();
    return () => { cancelled = true; };
  }, [handle]);

  const toggleFollow = async () => {
    if (!loggedIn) { window.location.href = '/sign-in'; return; }
    const next = !following;
    setFollowing(next);
    setFollowers((n) => Math.max(0, n + (next ? 1 : -1)));
    try {
      const r = next
        ? await fetch('/api/follow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: p.handle }) })
        : await fetch(`/api/follow?handle=${encodeURIComponent(p.handle)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j && typeof j.followers === 'number') { setFollowers(j.followers); setFollowing(!!j.isFollowing); }
    } catch { /* optimistic already applied */ }
  };

  const initials = (p?.displayName || handle || 'T').trim().slice(0, 1).toUpperCase();

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav />
      <div style={{ maxWidth: 720, margin: '24px auto', padding: '0 24px 48px' }}>
        {state === 'loading' && <div style={{ color: C.dim, fontSize: 13, padding: 40, textAlign: 'center' }}>Loading…</div>}

        {state === 'notfound' && (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '48px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.ink, marginBottom: 6 }}>Profile not found</div>
            <div style={{ fontSize: 13, color: C.muted }}>No trader with the handle @{handle}.</div>
          </div>
        )}

        {state === 'ok' && p && (
          <>
            {/* identity card */}
            <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                {p.avatarUrl
                  ? <img src={p.avatarUrl} alt="" width={72} height={72} style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                  : <span style={{ width: 72, height: 72, borderRadius: '50%', background: C.green, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 700, flexShrink: 0 }}>{initials}</span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 26, fontWeight: 600, color: C.ink, lineHeight: 1.1 }}>{p.displayName}</div>
                  <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>@{p.handle}</div>
                  <div style={{ fontSize: 11, color: C.dim, marginTop: 6 }}>Joined {fmtDate(p.joinedAt)}</div>
                  <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 12, color: C.muted }}>
                    <span><b style={{ color: C.ink }}>{followers}</b> followers</span>
                    <span><b style={{ color: C.ink }}>{followingCount}</b> following</span>
                  </div>
                  {(p.xHandle || p.igHandle) && (
                    <div style={{ display: 'flex', gap: 14, marginTop: 8 }}>
                      {p.xHandle && (
                        <a href={`https://x.com/${p.xHandle}`} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 12, color: C.green, textDecoration: 'none', fontWeight: 600 }}>𝕏 @{p.xHandle}</a>
                      )}
                      {p.igHandle && (
                        <a href={`https://instagram.com/${p.igHandle}`} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 12, color: C.green, textDecoration: 'none', fontWeight: 600 }}>📷 @{p.igHandle}</a>
                      )}
                    </div>
                  )}
                </div>
                {isOwn ? (
                  <a href="/settings/profile" style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.ink,
                    textDecoration: 'none', padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    Edit profile
                  </a>
                ) : (
                  <button onClick={toggleFollow}
                    style={{ background: following ? C.surface : C.green, border: following ? `1px solid ${C.border}` : 'none',
                      color: following ? C.ink : '#fff', padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 700,
                      cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: "'DM Sans',sans-serif" }}>
                    {following ? 'Following' : 'Follow'}
                  </button>
                )}
              </div>
              {p.bio && <div style={{ fontSize: 14, color: C.text, lineHeight: 1.5, marginTop: 14 }}>{p.bio}</div>}
            </div>

            {/* watchlist (opt-in) */}
            {p.showWatchlist && p.watchlist?.length > 0 && (
              <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
                <div style={{ fontSize: 11, color: C.muted, letterSpacing: '1px', marginBottom: 12 }}>WATCHING</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {p.watchlist.map((t) => (
                    <a key={t} href={`/ticker/${t}`} style={{ display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none',
                      background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 10px' }}>
                      <TickerLogo symbol={t} size={16} />
                      <span className="cp-tkr" style={{ fontSize: 12, color: C.ink }}>{t}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* recent Pit posts */}
            <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
              <div style={{ fontSize: 11, color: C.muted, letterSpacing: '1px', marginBottom: 12 }}>RECENT IN THE PIT</div>
              {p.recent?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {p.recent.map((r) => (
                    <div key={r.id} style={{ borderLeft: `3px solid ${C.border}`, paddingLeft: 10 }}>
                      <div style={{ fontSize: 13, color: C.text, lineHeight: 1.45 }}><Body text={r.body} /></div>
                      <div style={{ fontSize: 10, color: C.dim, marginTop: 3 }}>{fmtTime(r.createdAt)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: C.dim }}>No messages yet.</div>
              )}
            </div>
          </>
        )}
      </div>
      <Footer />
    </div>
  );
}
