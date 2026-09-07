'use client';

// Homepage "The Pit is live" widget — social proof that pulls visitors into the chat.
// Shows the online count (only once ≥3, so it never reads a lonely "1 online") + the latest
// messages, and a button that opens the Pit dock (via a window event PitDock listens for).
// Reads the public /api/pit/messages + /api/pit/presence — no client Ably connection needed.

import { useEffect, useState } from 'react';
import { C } from '../lib/cp-shared';
import { openPitDock } from '../lib/pitDockBus';

const PRO_GOLD = '#B8860B';
const ADMIN_PURPLE = '#7C3AED';
const nameColor = (t) => (t === 'admin' ? ADMIN_PURPLE : (t === 'pro' || t === 'elite') ? PRO_GOLD : C.ink);

function Avatar({ url, name, size = 24 }) {
  const [failed, setFailed] = useState(false);
  const initials = (name || 'T').trim().slice(0, 1).toUpperCase();
  if (url && !failed) return <img src={url} alt="" width={size} height={size} onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  return <span style={{ width: size, height: size, borderRadius: '50%', background: C.green, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.42, fontWeight: 700, flexShrink: 0 }}>{initials}</span>;
}

export default function PitLiveCard() {
  const [msgs, setMsgs] = useState([]);
  const [online, setOnline] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [m, p] = await Promise.all([
          fetch('/api/pit/messages', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch('/api/pit/presence', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        if (cancelled) return;
        if (m?.messages) setMsgs(m.messages.slice(-4).reverse());   // newest first
        if (p) setOnline(p.online || 0);
      } catch { /* ignore */ }
    };
    load();
    const id = setInterval(load, 45000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const openPit = () => openPitDock();

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ background: C.green, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>The Pit</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'rgba(255,255,255,0.9)', fontWeight: 600 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#7CFFB0', display: 'inline-block' }} />
          {online >= 3 ? `${online} online` : 'Live'}
        </span>
      </div>

      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {msgs.length === 0 ? (
          <div style={{ fontSize: 12, color: C.dim, padding: '6px 2px' }}>Be the first to say something in The Pit.</div>
        ) : msgs.map((m) => (
          <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Avatar url={m.avatarUrl} name={m.username} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: nameColor(m.tier) }}>{m.username}</span>
              <span style={{ fontSize: 12, color: C.text, marginLeft: 5, wordBreak: 'break-word' }}>{m.body}</span>
            </div>
          </div>
        ))}
        <button onClick={openPit}
          style={{ marginTop: 2, width: '100%', background: C.green, color: '#fff', border: 'none', borderRadius: 6,
            padding: '9px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
          Join The Pit →
        </button>
      </div>
    </div>
  );
}
