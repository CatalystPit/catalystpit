'use client';

import { useEffect, useState } from 'react';
import { C, BrandStyles, TopNav, Footer } from '../../lib/cp-shared';

function Avatar({ url, name, size = 38 }) {
  const [failed, setFailed] = useState(false);
  const initials = (name || 'T').trim().slice(0, 1).toUpperCase();
  if (url && !failed) return <img src={url} alt="" width={size} height={size} onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  return <span style={{ width: size, height: size, borderRadius: '50%', background: C.green, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.42, fontWeight: 700, flexShrink: 0 }}>{initials}</span>;
}

const medal = (rank) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : null);

export default function LeaderboardClient() {
  const [window, setWindow] = useState('all');
  const [leaders, setLeaders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/leaderboard?window=${window}`, { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (!cancelled) setLeaders(j?.leaders || []);
      } catch { if (!cancelled) setLeaders([]); }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [window]);

  const Tab = ({ id, label }) => (
    <button onClick={() => setWindow(id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 2px',
      fontSize: 14, fontWeight: window === id ? 700 : 500, color: window === id ? C.ink : C.muted,
      borderBottom: window === id ? `2px solid ${C.green}` : '2px solid transparent', fontFamily: "'DM Sans',sans-serif" }}>
      {label}
    </button>
  );

  const nameEl = (r) => r.handle
    ? <a href={`/u/${r.handle}`} style={{ color: C.ink, textDecoration: 'none', fontWeight: 700 }}>{r.displayName}</a>
    : <span style={{ color: C.ink, fontWeight: 700 }}>{r.displayName}</span>;

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Leaderboard" />
      <div style={{ maxWidth: 720, margin: '22px auto', padding: '0 20px 48px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 26 }}>🏆</span>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600, color: C.ink, margin: 0 }}>Leaderboard</h1>
        </div>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 14px', fontWeight: 300 }}>
          The most active and influential traders in The Pit. Pit Score rewards posts, reactions earned, followers, comments, and chat.
        </p>

        <div style={{ display: 'flex', gap: 20, borderBottom: `1px solid ${C.border}`, marginBottom: 14 }}>
          <Tab id="all" label="All time" />
          <Tab id="week" label="This week" />
        </div>

        {loading ? (
          <div style={{ color: C.dim, fontSize: 13, padding: 30, textAlign: 'center' }}>Loading…</div>
        ) : leaders.length === 0 ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
            No activity yet. Start posting and chatting to climb the board.
          </div>
        ) : (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            {leaders.map((r) => (
              <div key={r.rank} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                borderBottom: `1px solid ${C.surface}`, background: r.rank <= 3 ? C.greenLight : C.white }}>
                <div style={{ width: 30, textAlign: 'center', fontSize: medal(r.rank) ? 18 : 13, fontWeight: 700, color: C.muted }} className="cp-num">
                  {medal(r.rank) || r.rank}
                </div>
                <Avatar url={r.avatarUrl} name={r.displayName} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, lineHeight: 1.2 }}>{nameEl(r)}</div>
                  <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>
                    {r.posts} posts · {r.likesReceived} reactions · {r.followers} followers
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="cp-num" style={{ fontSize: 16, fontWeight: 700, color: C.green }}>{r.score.toLocaleString()}</div>
                  <div style={{ fontSize: 9, color: C.dim, letterSpacing: '0.5px' }}>PIT SCORE</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <Footer />
    </div>
  );
}
