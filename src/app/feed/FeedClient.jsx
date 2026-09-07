'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { C, BrandStyles, TopNav, Footer, startCheckout } from '../../lib/cp-shared';

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
function Avatar({ url, name, size = 40 }) {
  const [failed, setFailed] = useState(false);
  const initials = (name || 'T').trim().slice(0, 1).toUpperCase();
  if (url && !failed) return <img src={url} alt="" width={size} height={size} onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  return <span style={{ width: size, height: size, borderRadius: '50%', background: C.green, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.42, fontWeight: 700, flexShrink: 0 }}>{initials}</span>;
}
const fmtTime = (ts) => { try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

const MAX = 500;

// Expandable comment thread under a post. Loads on open; Pro/admin can add, author/admin can delete.
function CommentThread({ postId, me, onAdded, onRemoved }) {
  const [list, setList] = useState(null);
  const [input, setInput] = useState('');
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/feed/comment?postId=${postId}`, { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (!cancelled) setList(j?.comments || []);
      } catch { if (!cancelled) setList([]); }
    })();
    return () => { cancelled = true; };
  }, [postId]);

  const submit = async () => {
    const body = input.trim();
    if (!body) return;
    setPosting(true);
    try {
      const r = await fetch('/api/feed/comment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postId, body }) });
      if (r.ok) { const j = await r.json(); if (j.comment) { setList((l) => [...(l || []), j.comment]); setInput(''); onAdded && onAdded(); } }
    } catch { /* ignore */ }
    setPosting(false);
  };
  const del = async (id) => {
    try { const r = await fetch(`/api/feed/comment?id=${id}`, { method: 'DELETE' }); if (r.ok) { setList((l) => l.filter((c) => c.id !== id)); onRemoved && onRemoved(); } } catch { /* ignore */ }
  };

  return (
    <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
      {list === null ? (
        <div style={{ fontSize: 12, color: C.dim }}>Loading comments…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((c) => (
            <div key={c.id} className="feed-comment" style={{ display: 'flex', gap: 8 }}>
              <Avatar url={c.avatarUrl} name={c.username} size={26} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  {c.handle
                    ? <a href={`/u/${c.handle}`} style={{ fontSize: 12, fontWeight: 700, color: C.ink, textDecoration: 'none' }}>{c.username}</a>
                    : <span style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{c.username}</span>}
                  <span style={{ fontSize: 10, color: C.dim }}>· {fmtTime(c.createdAt)}</span>
                  {(me.admin || (me.userId && me.userId === c.userId)) && (
                    <button onClick={() => del(c.id)} title="Delete" className="feed-cdel"
                      style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: C.red, fontSize: 11, opacity: 0 }}>✕</button>
                  )}
                </div>
                <div style={{ fontSize: 13, color: C.text, lineHeight: 1.4, wordBreak: 'break-word' }}><Body text={c.body} /></div>
              </div>
            </div>
          ))}
          {list.length === 0 && <div style={{ fontSize: 12, color: C.dim }}>No comments yet.</div>}

          {me.canPost ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                maxLength={500} placeholder="Add a comment…"
                style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: 'none', color: C.ink }} />
              <button onClick={submit} disabled={posting || !input.trim()}
                style={{ background: input.trim() ? C.green : C.surface2, color: input.trim() ? '#fff' : C.dim, border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 12, fontWeight: 600, cursor: input.trim() ? 'pointer' : 'default' }}>
                Reply
              </button>
            </div>
          ) : me.loggedIn ? (
            <div style={{ fontSize: 12, color: C.dim }}>Pro members can comment. <a href="#" onClick={(e) => { e.preventDefault(); startCheckout(); }} style={{ color: C.green, fontWeight: 600 }}>Upgrade</a></div>
          ) : (
            <div style={{ fontSize: 12, color: C.dim }}><a href="/sign-in" style={{ color: C.green, fontWeight: 600 }}>Sign in</a> to comment.</div>
          )}
        </div>
      )}
      <style>{`.feed-comment:hover .feed-cdel { opacity: 1 !important; }`}</style>
    </div>
  );
}

function PostCard({ post, me, onLike, onDelete }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(post.commentCount || 0);
  return (
    <div className="feed-post" style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
      <div style={{ display: 'flex', gap: 11 }}>
        <Avatar url={post.avatarUrl} name={post.username} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
            {post.handle
              ? <a href={`/u/${post.handle}`} style={{ fontSize: 14, fontWeight: 700, color: C.ink, textDecoration: 'none' }}>{post.username}</a>
              : <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{post.username}</span>}
            {post.handle && <span style={{ fontSize: 12, color: C.dim }}>@{post.handle}</span>}
            <span style={{ fontSize: 11, color: C.dim }}>· {fmtTime(post.createdAt)}</span>
            {(me.admin || (me.userId && me.userId === post.userId)) && (
              <button onClick={() => onDelete(post.id)} title="Delete" className="feed-del"
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: C.red, fontSize: 12, opacity: 0 }}>✕</button>
            )}
          </div>
          {post.body && (
            <div style={{ fontSize: 15, color: C.text, lineHeight: 1.5, marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              <Body text={post.body} />
            </div>
          )}
          {post.imageUrl && (
            <a href={post.imageUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginTop: 10 }}>
              <img src={post.imageUrl} alt="" style={{ maxWidth: '100%', borderRadius: 8, border: `1px solid ${C.border}` }} />
            </a>
          )}
          <div style={{ marginTop: 9, display: 'flex', gap: 18, alignItems: 'center' }}>
            <button onClick={() => onLike(post)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
                color: post.liked ? C.red : C.dim, fontSize: 13, fontWeight: 600, padding: 0, fontFamily: "'DM Sans',sans-serif" }}>
              <span style={{ fontSize: 15 }}>{post.liked ? '♥' : '♡'}</span>
              {post.likeCount > 0 && post.likeCount}
            </button>
            <button onClick={() => setOpen((o) => !o)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
                color: C.dim, fontSize: 13, fontWeight: 600, padding: 0, fontFamily: "'DM Sans',sans-serif" }}>
              <span style={{ fontSize: 14 }}>💬</span>
              {count > 0 && count}
            </button>
          </div>
          {open && <CommentThread postId={post.id} me={me} onAdded={() => setCount((c) => c + 1)} onRemoved={() => setCount((c) => Math.max(0, c - 1))} />}
        </div>
      </div>
    </div>
  );
}

export default function FeedClient() {
  const [scope, setScope] = useState('global');
  const [posts, setPosts] = useState([]);
  const [me, setMe] = useState({ canPost: false, loggedIn: false, admin: false });
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [posting, setPosting] = useState(false);
  const [notice, setNotice] = useState('');
  const [more, setMore] = useState(false);
  const [image, setImage] = useState(null);           // selected File
  const [imagePreview, setImagePreview] = useState(null); // object URL
  const fileRef = useRef(null);

  const pickImage = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith('image/')) { setNotice('Images only.'); return; }
    if (f.size > 4 * 1024 * 1024) { setNotice('Image must be under 4MB.'); return; }
    setNotice('');
    setImage(f);
    setImagePreview(URL.createObjectURL(f));
  };
  const clearImage = () => { setImage(null); setImagePreview(null); if (fileRef.current) fileRef.current.value = ''; };

  const load = useCallback(async (sc) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/feed?scope=${sc}`, { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      setPosts(j?.posts || []);
      if (j?.me) setMe(j.me);
      setMore((j?.posts || []).length >= 30);
    } catch { setPosts([]); }
    setLoading(false);
  }, []);

  useEffect(() => { load(scope); }, [scope, load]);

  const loadMore = async () => {
    const last = posts[posts.length - 1];
    if (!last) return;
    try {
      const r = await fetch(`/api/feed?scope=${scope}&before=${encodeURIComponent(last.createdAt)}`, { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      const next = j?.posts || [];
      setPosts((p) => [...p, ...next]);
      setMore(next.length >= 30);
    } catch { /* ignore */ }
  };

  const submit = async () => {
    const body = input.trim();
    if (!body && !image) return;
    setPosting(true); setNotice('');
    try {
      let imageUrl = null;
      if (image) {
        const fd = new FormData();
        fd.append('file', image);
        const up = await fetch('/api/upload', { method: 'POST', body: fd });
        if (!up.ok) {
          const ej = await up.json().catch(() => ({}));
          setNotice(ej.error === 'uploads_not_configured' ? 'Image uploads not set up yet.' : 'Image upload failed.');
          setPosting(false); return;
        }
        imageUrl = (await up.json()).url;
      }
      const r = await fetch('/api/feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, imageUrl }) });
      if (r.status === 429) { setNotice('Slow down a moment.'); }
      else if (r.status === 403) { setNotice('Pro members only.'); }
      else if (!r.ok) { setNotice('Could not post.'); }
      else { const j = await r.json(); if (j?.post) { setPosts((p) => [j.post, ...p]); setInput(''); clearImage(); } }
    } catch { setNotice('Could not post.'); }
    setPosting(false);
  };

  const like = async (post) => {
    if (!me.loggedIn) { setNotice('Sign in to like.'); return; }
    const on = !post.liked;
    setPosts((p) => p.map((x) => x.id === post.id ? { ...x, liked: on, likeCount: Math.max(0, (x.likeCount || 0) + (on ? 1 : -1)) } : x));
    try {
      const r = await fetch('/api/feed/like', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postId: post.id, on }) });
      const j = await r.json();
      if (j && j.likeCount != null) setPosts((p) => p.map((x) => x.id === post.id ? { ...x, liked: j.liked, likeCount: j.likeCount } : x));
    } catch { /* optimistic already applied */ }
  };

  const del = async (id) => {
    try { const r = await fetch(`/api/feed?id=${id}`, { method: 'DELETE' }); if (r.ok) setPosts((p) => p.filter((x) => x.id !== id)); } catch { /* ignore */ }
  };

  const Tab = ({ id, label }) => (
    <button onClick={() => setScope(id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 2px',
      fontSize: 14, fontWeight: scope === id ? 700 : 500, color: scope === id ? C.ink : C.muted,
      borderBottom: scope === id ? `2px solid ${C.green}` : '2px solid transparent', fontFamily: "'DM Sans',sans-serif" }}>
      {label}
    </button>
  );

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Feed" />
      <div style={{ maxWidth: 640, margin: '20px auto', padding: '0 20px 48px' }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600, color: C.ink, margin: '0 0 2px' }}>Feed</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 14px', fontWeight: 300 }}>Traders sharing thoughts, ideas, and catalysts. Post with a $CASHTAG to tag a stock.</p>

        <div style={{ display: 'flex', gap: 20, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
          <Tab id="global" label="For you" />
          <Tab id="following" label="Following" />
        </div>

        {/* composer */}
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
          {me.canPost ? (
            <>
              <textarea value={input} onChange={(e) => setInput(e.target.value)} maxLength={MAX} rows={3}
                placeholder="Share a thought…  ($NVDA tags a ticker)"
                style={{ width: '100%', resize: 'vertical', border: 'none', outline: 'none', fontSize: 15, fontFamily: "'DM Sans',sans-serif", color: C.ink, boxSizing: 'border-box' }} />
              {imagePreview && (
                <div style={{ position: 'relative', marginTop: 8, display: 'inline-block' }}>
                  <img src={imagePreview} alt="" style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, border: `1px solid ${C.border}`, display: 'block' }} />
                  <button onClick={clearImage} aria-label="Remove image"
                    style={{ position: 'absolute', top: 6, right: 6, width: 26, height: 26, borderRadius: '50%', border: 'none',
                      background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>✕</button>
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={pickImage} style={{ display: 'none' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <button onClick={() => fileRef.current?.click()} title="Add a photo"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.green, fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0, fontFamily: "'DM Sans',sans-serif" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" />
                  </svg>
                  Photo
                </button>
                <span style={{ fontSize: 11, color: C.dim }}>{input.length}/{MAX}</span>
                {notice && <span style={{ fontSize: 12, color: C.muted }}>{notice}</span>}
                <button onClick={submit} disabled={posting || (!input.trim() && !image)}
                  style={{ marginLeft: 'auto', background: (input.trim() || image) ? C.green : C.surface2, color: (input.trim() || image) ? '#fff' : C.dim,
                    border: 'none', borderRadius: 6, padding: '9px 20px', fontSize: 13, fontWeight: 600, cursor: (input.trim() || image) ? 'pointer' : 'default' }}>
                  {posting ? 'Posting…' : 'Post'}
                </button>
              </div>
            </>
          ) : me.loggedIn ? (
            <button onClick={() => startCheckout()} style={{ width: '100%', background: C.green, color: '#fff', border: 'none', borderRadius: 6, padding: '11px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              🔒 Upgrade to Pro to post to the feed
            </button>
          ) : (
            <a href="/sign-in" style={{ display: 'block', textAlign: 'center', background: C.green, color: '#fff', textDecoration: 'none', borderRadius: 6, padding: '11px', fontSize: 13, fontWeight: 600 }}>
              Sign in to post
            </a>
          )}
        </div>

        {/* posts */}
        {loading ? (
          <div style={{ color: C.dim, fontSize: 13, padding: 30, textAlign: 'center' }}>Loading…</div>
        ) : posts.length === 0 ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
            {scope === 'following' ? 'Follow some traders to see their posts here.' : 'No posts yet. Be the first.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {posts.map((post) => (
              <PostCard key={post.id} post={post} me={me} onLike={like} onDelete={del} />
            ))}
            {more && (
              <button onClick={loadMore} style={{ background: C.white, border: `1px solid ${C.border}`, color: C.ink, borderRadius: 8, padding: '10px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Load more
              </button>
            )}
          </div>
        )}
      </div>
      <Footer />
      <style>{`.feed-post:hover .feed-del { opacity: 1 !important; }`}</style>
    </div>
  );
}
