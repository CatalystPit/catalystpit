'use client';

// PitChat — the live room UI. Reads history from /api/pit/messages (open to all), connects to
// Ably for realtime (token from /api/pit/token), and enforces posting via the server (Pro-only).
// Anyone can read; free signed-in users see an "Upgrade to Pro" composer; signed-out see "Sign in".
// Ably degrades gracefully: if the token route is 503 (no ABLY_API_KEY yet) the room still shows
// history and just isn't live.

import { useEffect, useRef, useState, useCallback } from 'react';
import { C, startCheckout } from '../lib/cp-shared';

// Ably's npm bundle fails Next's client webpack parse ('super' outside a method), so we load the
// official Ably CDN build on the client and use window.Ably (mirrors how we load X's widgets.js).
const ABLY_SRC = 'https://cdn.ably.com/lib/ably.min-2.js';
let ablyPromise = null;
function loadAbly() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.Ably) return Promise.resolve(window.Ably);
  if (ablyPromise) return ablyPromise;
  ablyPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${ABLY_SRC}"]`);
    const s = existing || document.createElement('script');
    s.src = ABLY_SRC; s.async = true;
    s.addEventListener('load', () => (window.Ably ? resolve(window.Ably) : reject(new Error('Ably missing'))));
    s.addEventListener('error', () => reject(new Error('Ably CDN failed')));
    if (!existing) document.body.appendChild(s);
  });
  return ablyPromise;
}

const CASHTAG_RE = /\$[A-Za-z]{1,5}\b/g;

function Avatar({ url, name, size = 30 }) {
  const [failed, setFailed] = useState(false);
  const initials = (name || 'T').trim().slice(0, 1).toUpperCase();
  if (url && !failed) {
    return <img src={url} alt="" width={size} height={size} onError={() => setFailed(true)}
      style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, objectFit: 'cover' }} />;
  }
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, background: C.green,
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.42, fontWeight: 700, fontFamily: "'DM Sans',sans-serif" }}>
      {initials}
    </span>
  );
}

// Render body with $CASHTAGS linked to the ticker page.
function Body({ text }) {
  const parts = [];
  let last = 0, m;
  CASHTAG_RE.lastIndex = 0;
  while ((m = CASHTAG_RE.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const sym = m[0].slice(1).toUpperCase();
    parts.push(
      <a key={m.index} href={`/ticker/${sym}`}
        style={{ color: C.green, fontWeight: 600, textDecoration: 'none' }}>{m[0].toUpperCase()}</a>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

const fmtTime = (ts) => {
  try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
};

// Composer emoji palette (for typing emojis into messages). Message reactions are just 👍/👎.
const EMOJIS = ['😀', '😂', '😅', '😍', '😎', '🤔', '😳', '😭', '😡', '🥳', '👍', '👎', '👏', '🙏', '💪', '🤝',
  '🔥', '💯', '🚀', '📈', '📉', '💰', '💎', '🐂', '🐻', '⚠️', '✅', '❌', '❤️', '👀', '🎯', '🤑'];

// Clean line thumb icons (up/down) — Facebook-style like/dislike, not childish emoji.
function Thumb({ down, size = 15, color, filled }) {
  const up = 'M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : 'none'} stroke={color || 'currentColor'}
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={down ? { transform: 'rotate(180deg)' } : undefined}>
      <path d={up} />
    </svg>
  );
}

// Reactions mirror the feed: one per user (mutually exclusive), pick via hover/hold.
const CHAT_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '😡'];
const CHAT_LABELS = { '👍': 'Like', '❤️': 'Love', '😂': 'Haha', '😮': 'Wow', '😢': 'Sad', '😡': 'Angry' };

const myReactionOf = (m) => (m.reactions || []).find((r) => r.mine)?.emoji || null;
const reactionsFromCounts = (counts, myEmoji) =>
  Object.entries(counts || {}).map(([emoji, count]) => ({ emoji, count, mine: emoji === myEmoji }));
// Optimistic exclusive change: user switches from oldEmoji → newEmoji (either may be null).
function applyExclusive(m, oldEmoji, newEmoji) {
  const counts = {};
  for (const r of (m.reactions || [])) counts[r.emoji] = r.count;
  if (oldEmoji && counts[oldEmoji]) { counts[oldEmoji] -= 1; if (counts[oldEmoji] <= 0) delete counts[oldEmoji]; }
  if (newEmoji) counts[newEmoji] = (counts[newEmoji] || 0) + 1;
  return { ...m, reactions: reactionsFromCounts(counts, newEmoji) };
}

export default function PitChat({ height = 620, onClose }) {
  const [messages, setMessages] = useState([]);
  const [me, setMe] = useState({ canPost: false, loggedIn: false, admin: false });
  const [online, setOnline] = useState(0);
  const [live, setLive] = useState(false);
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState('');
  const [showEmoji, setShowEmoji] = useState(false); // composer emoji palette
  const [reactOpenId, setReactOpenId] = useState(null); // message whose reaction picker is open
  const listRef = useRef(null);
  const clientRef = useRef(null);
  const meIdRef = useRef(null);                       // stable userId for the live reaction handler
  const holdRef = useRef(null);
  const startHold = (id) => { holdRef.current = setTimeout(() => setReactOpenId(id), 350); };
  const cancelHold = () => { if (holdRef.current) clearTimeout(holdRef.current); };

  const addMessage = useCallback((msg) => {
    if (!msg || msg.id == null) return;
    const withRx = { ...msg, reactions: msg.reactions || [] };
    setMessages((prev) => (prev.some((m) => m.id === withRx.id) ? prev : [...prev, withRx]));
  }, []);
  const removeMessage = useCallback((id) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // Load history + viewer context, then wire up realtime.
  useEffect(() => {
    let cancelled = false;
    let channel, client;

    (async () => {
      try {
        const r = await fetch('/api/pit/messages', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (cancelled) return;
        if (j?.messages) setMessages(j.messages.map((m) => ({ ...m, reactions: m.reactions || [] })));
        if (j?.me) { setMe(j.me); meIdRef.current = j.me.userId || null; }
      } catch { /* keep empty */ }

      try {
        const Ably = await loadAbly();
        if (cancelled) return;
        client = new Ably.Realtime({ authUrl: '/api/pit/token', authMethod: 'POST', echoMessages: true });
        clientRef.current = client;
        client.connection.on('connected', () => !cancelled && setLive(true));
        client.connection.on('failed', () => !cancelled && setLive(false));
        client.connection.on('disconnected', () => !cancelled && setLive(false));

        channel = client.channels.get('the-pit');
        channel.subscribe('message', (m) => addMessage(m.data));
        channel.subscribe('delete', (m) => removeMessage(m.data?.id));
        channel.subscribe('reaction', (m) => {
          const d = m.data;
          if (!d || d.userId === meIdRef.current) return;   // our own change was applied optimistically
          // Broadcast carries aggregate counts; keep our own reaction flag intact.
          setMessages((prev) => prev.map((msg) => (msg.id === d.messageId
            ? { ...msg, reactions: reactionsFromCounts(d.counts, myReactionOf(msg)) } : msg)));
        });

        // presence — enter only if signed-in (anon has no clientId / presence capability)
        const syncOnline = async () => {
          try { const members = await channel.presence.get(); if (!cancelled) setOnline(members.length); }
          catch { /* ignore */ }
        };
        channel.presence.subscribe(['enter', 'leave', 'present'], syncOnline);
        // enter after connect; wrapped so a presence-capability error doesn't break subscribe
        client.connection.once('connected', async () => {
          try {
            // read fresh identity from the loaded context
            await channel.presence.enter({});
          } catch { /* anon or no presence cap */ }
          syncOnline();
        });
      } catch (e) {
        console.log(`[pit] realtime init failed: ${e.message}`);
      }
    })();

    return () => {
      cancelled = true;
      try { channel && channel.unsubscribe(); } catch {}
      try { client && client.close(); } catch {}
      clientRef.current = null;
    };
  }, [addMessage, removeMessage]);

  // Auto-scroll to newest when near the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const body = input.trim();
    if (!body) return;
    setInput('');
    setNotice('');
    try {
      const r = await fetch('/api/pit/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
      });
      if (r.status === 429) { setNotice('Slow down a moment.'); return; }
      if (r.status === 403) { setNotice('Pro members only.'); return; }
      if (!r.ok) { setNotice('Could not send.'); return; }
      const j = await r.json();
      if (j?.message) addMessage(j.message);   // dedup-safe; also arrives via broadcast
    } catch { setNotice('Could not send.'); }
  };

  // Set (or toggle off) the user's single reaction on a message — mutually exclusive.
  const setReaction = async (msg, emoji) => {
    if (!me.loggedIn) { setNotice('Sign in to react.'); return; }
    const mineNow = myReactionOf(msg);
    const target = mineNow === emoji ? null : emoji;   // re-picking removes it
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? applyExclusive(m, mineNow, target) : m)));
    setReactOpenId(null);
    try {
      const r = await fetch('/api/pit/react', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: msg.id, emoji: target }) });
      const j = await r.json();
      if (j && j.counts) setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, reactions: reactionsFromCounts(j.counts, target) } : m)));
    } catch { /* optimistic already applied */ }
  };

  const insertEmoji = (e) => { setInput((v) => v + e); setShowEmoji(false); };
  const reply = (m) => { const tag = `@${m.handle || m.username} `; setInput((v) => (v.startsWith(tag) ? v : tag + v)); };

  const report = async (id) => {
    try {
      await fetch('/api/pit/report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: id }),
      });
      setNotice('Reported. Thanks.');
    } catch { /* ignore */ }
  };
  const del = async (id) => {
    try {
      const r = await fetch(`/api/pit/messages?id=${id}`, { method: 'DELETE' });
      if (r.ok) removeMessage(id);
    } catch { /* ignore */ }
  };

  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden',
      fontFamily: "'DM Sans',sans-serif", display: 'flex', flexDirection: 'column', height }}>
      {/* header */}
      <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex',
        alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>The Pit</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11,
          color: live ? C.green : C.dim, fontWeight: 600 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%',
            background: live ? C.green : C.hint, display: 'inline-block' }} />
          {online} online
        </span>
        {onClose && (
          <button onClick={onClose} aria-label="Collapse The Pit"
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
              color: C.muted, fontSize: 16, lineHeight: 1, padding: '2px 4px' }}>✕</button>
        )}
      </div>

      {/* messages */}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', color: C.dim, fontSize: 12, padding: 20 }}>
            No messages yet. {me.canPost ? 'Say something.' : 'Pro members start the conversation.'}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="pit-msg" style={{ display: 'flex', gap: 9, padding: '6px 8px', borderRadius: 6 }}>
            {m.handle ? (
              <a href={`/u/${m.handle}`} className="pit-av" title={`@${m.handle}`} style={{ display: 'inline-flex', flexShrink: 0 }}>
                <Avatar url={m.avatarUrl} name={m.username} />
              </a>
            ) : <Avatar url={m.avatarUrl} name={m.username} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                {m.handle ? (
                  <a href={`/u/${m.handle}`} style={{ fontSize: 12, fontWeight: 700, color: C.ink, textDecoration: 'none' }}>
                    {m.username}
                  </a>
                ) : (
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{m.username}</span>
                )}
                {m.handle && (
                  <a href={`/u/${m.handle}`} style={{ fontSize: 10, color: C.dim, textDecoration: 'none' }}>@{m.handle}</a>
                )}
                <span style={{ fontSize: 10, color: C.dim }}>{fmtTime(m.createdAt)}</span>
                <span className="pit-actions" style={{ marginLeft: 'auto', display: 'flex', gap: 8, opacity: 0 }}>
                  {me.loggedIn && m.userId !== me.userId && (
                    <button onClick={() => report(m.id)} title="Report"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.dim, fontSize: 11, padding: 0 }}>⚑</button>
                  )}
                  {me.admin && (
                    <button onClick={() => del(m.id)} title="Delete"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.red, fontSize: 11, padding: 0 }}>✕</button>
                  )}
                </span>
              </div>
              <div style={{ fontSize: 13, color: C.text, lineHeight: 1.4, wordBreak: 'break-word' }}>
                <Body text={m.body} />
              </div>

              {/* Facebook-style row: Like (hover/hold → pick reaction) · Reply · summary */}
              {(() => {
                const mine = myReactionOf(m);
                const total = (m.reactions || []).reduce((s, r) => s + r.count, 0);
                const emojis = (m.reactions || []).map((r) => r.emoji);
                const btn = { background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, padding: 0, fontFamily: "'DM Sans',sans-serif" };
                return (
                  <div style={{ display: 'flex', gap: 14, marginTop: 5, alignItems: 'center' }}>
                    <div style={{ position: 'relative', display: 'inline-flex' }}
                      onMouseEnter={() => setReactOpenId(m.id)} onMouseLeave={() => setReactOpenId(null)}>
                      <button onClick={() => setReaction(m, mine || '👍')}
                        onTouchStart={() => startHold(m.id)} onTouchEnd={cancelHold} onTouchMove={cancelHold}
                        style={{ ...btn, color: mine ? C.green : C.dim }}>
                        {mine && mine !== '👍' ? <span style={{ fontSize: 14 }}>{mine}</span> : <Thumb color={mine === '👍' ? C.green : C.dim} filled={mine === '👍'} />}
                        {mine ? CHAT_LABELS[mine] || 'Liked' : 'Like'}
                      </button>
                      {reactOpenId === m.id && (
                        <div style={{ position: 'absolute', bottom: '150%', left: 0, zIndex: 11, display: 'flex', gap: 2,
                          background: C.white, border: `1px solid ${C.border}`, borderRadius: 20, padding: '4px 7px', boxShadow: '0 6px 18px rgba(0,0,0,0.18)' }}>
                          {CHAT_REACTIONS.map((e) => (
                            <button key={e} onClick={() => setReaction(m, e)} title={CHAT_LABELS[e]}
                              style={{ background: mine === e ? C.greenLight : 'none', border: 'none', cursor: 'pointer', fontSize: 19, padding: '1px 3px', lineHeight: 1, borderRadius: '50%' }}>{e}</button>
                          ))}
                        </div>
                      )}
                    </div>
                    {me.loggedIn && <button onClick={() => reply(m)} style={{ ...btn, color: C.dim }}>Reply</button>}
                    {total > 0 && <span style={{ fontSize: 11, color: C.muted, display: 'inline-flex', alignItems: 'center', gap: 3 }}>{[...new Set(emojis)].slice(0, 3).join('')} {total}</span>}
                  </div>
                );
              })()}
            </div>
          </div>
        ))}
      </div>

      {/* composer / gated CTA */}
      <div style={{ borderTop: `1px solid ${C.border}`, padding: 10, flexShrink: 0 }}>
        {notice && <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{notice}</div>}
        {me.canPost ? (
          <div style={{ position: 'relative' }}>
            {showEmoji && (
              <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, zIndex: 5,
                background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: 8, width: 250,
                boxShadow: '0 6px 20px rgba(0,0,0,0.12)', display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2 }}>
                {EMOJIS.map((e) => (
                  <button key={e} onClick={() => insertEmoji(e)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, padding: 3, lineHeight: 1, borderRadius: 4 }}>{e}</button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <button onClick={() => setShowEmoji((s) => !s)} title="Emoji"
                style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer',
                  fontSize: 17, lineHeight: 1, padding: '7px 9px', flexShrink: 0 }}>😊</button>
              <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey}
                rows={1} placeholder="Message the Pit…  ($NVDA links a ticker)"
                style={{ flex: 1, resize: 'none', maxHeight: 90, padding: '9px 10px', borderRadius: 6,
                  border: `1px solid ${C.border}`, fontSize: 13, fontFamily: "'DM Sans',sans-serif",
                  outline: 'none', color: C.ink }} />
              <button onClick={send} disabled={!input.trim()}
                style={{ background: input.trim() ? C.green : C.surface2, color: input.trim() ? '#fff' : C.dim,
                  border: 'none', borderRadius: 6, padding: '9px 16px', fontSize: 13, fontWeight: 600,
                  cursor: input.trim() ? 'pointer' : 'default', fontFamily: "'DM Sans',sans-serif" }}>
                Send
              </button>
            </div>
          </div>
        ) : me.loggedIn ? (
          <button onClick={() => startCheckout()}
            style={{ width: '100%', background: C.green, color: '#fff', border: 'none', borderRadius: 6,
              padding: '11px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
            🔒 Upgrade to Pro to join the conversation
          </button>
        ) : (
          <a href="/sign-in" style={{ display: 'block', textAlign: 'center', background: C.green, color: '#fff',
            textDecoration: 'none', borderRadius: 6, padding: '11px', fontSize: 13, fontWeight: 600,
            fontFamily: "'DM Sans',sans-serif" }}>
            Sign in to chat
          </a>
        )}
        <div style={{ marginTop: 7, fontSize: 10, color: C.dim, textAlign: 'center', lineHeight: 1.4 }}>
          Be civil. Not investment advice.
          {me.loggedIn && <> · <a href="/settings/profile" style={{ color: C.muted, textDecoration: 'underline' }}>Your profile</a></>}
        </div>
      </div>

      <style>{`
        .pit-msg { transition: background 0.12s ease; }
        .pit-msg:hover { background: ${C.surface}; }
        .pit-msg:hover .pit-actions { opacity: 1 !important; }
        .pit-av:hover { opacity: 0.82; }
      `}</style>
    </div>
  );
}
