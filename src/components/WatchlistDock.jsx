'use client';

// WatchlistDock — the signed-in user's watchlist as a collapsible right-edge dock, mirroring the
// Tape (left) and Pit chat (right) docks. Sits on the TOP half of the right edge (Pit chat takes
// the bottom half); lets us keep Watchlist off the top nav. Desktop signed-in only — mobile keeps
// the Watchlist link in the burger menu. Pushes content via --cp-watch (shell margin = max of docks).

import { useEffect, useState, useRef, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import { C, TickerLogo, fmt2 } from '../lib/cp-shared';

const PANEL_W = 330;                 // match the Pit chat + Tape dock width
const MOBILE_Q = '(max-width: 860px)';
const PREF_KEY = 'cp_watch_open';

function Body({ onClose }) {
  const [lists, setLists] = useState([]);        // [{id,name,isDefault,count}]
  const [activeId, setActiveId] = useState(null);
  const [rows, setRows] = useState(null);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [sugg, setSugg] = useState([]);
  const [msg, setMsg] = useState('');
  const [dragIdx, setDragIdx] = useState(null);
  const timer = useRef(null);

  const saveOrder = async (order) => {
    try { await fetch('/api/watchlist', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listId: activeId, order }) }); } catch { /* ignore */ }
  };
  const onDropRow = (toIdx) => {
    if (dragIdx == null || dragIdx === toIdx) { setDragIdx(null); return; }
    setRows((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      const [m] = next.splice(dragIdx, 1);
      next.splice(toIdx, 0, m);
      saveOrder(next.map((r) => r.ticker));
      return next;
    });
    setDragIdx(null);
  };

  const loadLists = useCallback(async () => {
    try {
      const r = await fetch('/api/watchlist/lists', { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (!j?.lists) return;
      setLists(j.lists);
      setActiveId((prev) => {
        let saved = prev;
        if (saved == null) { try { saved = parseInt(localStorage.getItem('cp_watch_list') || '', 10) || null; } catch { /* ignore */ } }
        return j.lists.some((l) => l.id === saved) ? saved : j.defaultId;
      });
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadLists(); }, [loadLists]);

  const loadRows = useCallback(async (id) => {
    if (!id) return;
    try { const r = await fetch(`/api/watchlist?prices=1&listId=${id}`, { cache: 'no-store' }); const j = r.ok ? await r.json() : null; setRows(Array.isArray(j) ? j : []); }
    catch { setRows([]); }
  }, []);
  useEffect(() => {
    if (!activeId) return;
    setRows(null); loadRows(activeId);
    const t = setInterval(() => loadRows(activeId), 60000);
    return () => clearInterval(t);
  }, [activeId, loadRows]);

  const activeList = lists.find((l) => l.id === activeId);
  const activeName = activeList?.name || 'Watchlist';

  const switchList = (id) => { setActiveId(id); setMenu(false); setRenaming(false); setAdding(false); try { localStorage.setItem('cp_watch_list', String(id)); } catch { /* ignore */ } };

  const newList = async () => {
    setMsg('');
    try {
      const r = await fetch('/api/watchlist/lists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New list' }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 403) { setMsg(j.error || 'Multiple watchlists are a Pro feature.'); return; }
      if (j?.lists) {
        setLists(j.lists);
        const created = j.lists.reduce((a, b) => (b.id > (a?.id || 0) ? b : a), null);
        if (created) { switchList(created.id); setRenaming(true); setRenameVal(created.name); }
      }
    } catch { setMsg('Could not create list.'); }
  };
  const doRename = async () => {
    const nm = renameVal.trim();
    setRenaming(false);
    if (!nm || !activeId) return;
    try { const r = await fetch('/api/watchlist/lists', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: activeId, name: nm }) }); const j = r.ok ? await r.json() : null; if (j?.lists) setLists(j.lists); } catch { /* ignore */ }
  };
  const doDelete = async () => {
    if (!activeId || activeList?.isDefault) return;
    setMenu(false);
    try { const r = await fetch(`/api/watchlist/lists?id=${activeId}`, { method: 'DELETE' }); const j = r.ok ? await r.json() : null; if (j?.lists) { setLists(j.lists); switchList(j.defaultId); } } catch { /* ignore */ }
  };

  const onQ = (val) => {
    const up = val.toUpperCase(); setQ(up); setMsg('');
    if (timer.current) clearTimeout(timer.current);
    if (up.trim().length < 1) { setSugg([]); return; }
    timer.current = setTimeout(async () => {
      try { const r = await fetch(`/api/symbol-search?q=${encodeURIComponent(up.trim())}`); const j = r.ok ? await r.json() : null; setSugg(Array.isArray(j?.results) ? j.results : []); }
      catch { setSugg([]); }
    }, 130);
  };
  const add = async (ticker) => {
    const t = String(ticker || '').trim().toUpperCase(); if (!t || !activeId) return;
    setQ(''); setSugg([]);
    try {
      const r = await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker: t, listId: activeId }) });
      if (r.status === 403) { const j = await r.json().catch(() => ({})); setMsg(j.error || 'List full.'); return; }
      if (!r.ok) { setMsg('Could not add that ticker.'); return; }
      loadRows(activeId); loadLists();
    } catch { setMsg('Could not add that ticker.'); }
  };
  const remove = async (ticker) => {
    try { await fetch(`/api/watchlist?ticker=${encodeURIComponent(ticker)}&listId=${activeId}`, { method: 'DELETE' }); loadRows(activeId); loadLists(); } catch { /* ignore */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.white, borderLeft: `1px solid ${C.border}` }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', background: C.green, color: '#fff', flexShrink: 0 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        {renaming ? (
          <input autoFocus value={renameVal} onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doRename(); if (e.key === 'Escape') setRenaming(false); }} onBlur={doRename}
            style={{ flex: 1, minWidth: 0, height: 24, borderRadius: 5, border: 'none', padding: '0 8px', fontSize: 13, fontWeight: 700, fontFamily: "'DM Sans',sans-serif", outline: 'none' }} />
        ) : (
          <button onClick={() => setMenu((v) => !v)} title="Switch or manage lists"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, letterSpacing: '0.3px', padding: 0, minWidth: 0 }}>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>{activeName}</span>
            <span style={{ fontSize: 10, opacity: 0.9 }}>▾</span>
          </button>
        )}
        <button onClick={() => { setAdding((v) => !v); setMsg(''); setQ(''); setSugg([]); }} aria-label="Add ticker"
          title="Add a ticker" style={{ marginLeft: 'auto', background: 'rgba(255,255,255,0.18)', border: 'none', color: '#fff', cursor: 'pointer', width: 22, height: 22, borderRadius: 5, fontSize: 17, lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          {adding ? '×' : '+'}
        </button>
        <button onClick={onClose} aria-label="Collapse watchlist" style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>›</button>

        {menu && (
          <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 8, minWidth: 210, zIndex: 6, background: C.white, color: C.ink, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 10px 26px rgba(0,0,0,0.18)', overflow: 'hidden' }}>
            {lists.map((l) => (
              <button key={l.id} onClick={() => switchList(l.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 12px', background: l.id === activeId ? C.greenLight : '#fff', border: 'none', borderBottom: `1px solid ${C.surface}`, cursor: 'pointer', fontSize: 12.5, fontWeight: l.id === activeId ? 700 : 500, color: C.ink, fontFamily: "'DM Sans',sans-serif" }}>
                <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</span>
                <span style={{ fontSize: 10, color: C.dim }}>{l.count}</span>
              </button>
            ))}
            <button onClick={newList} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: C.white, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: C.green, fontFamily: "'DM Sans',sans-serif" }}>＋ New list</button>
            {activeList && (
              <button onClick={() => { setMenu(false); setRenaming(true); setRenameVal(activeName); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: C.white, border: 'none', borderTop: `1px solid ${C.surface}`, cursor: 'pointer', fontSize: 12, color: C.muted, fontFamily: "'DM Sans',sans-serif" }}>✎ Rename</button>
            )}
            {activeList && !activeList.isDefault && (
              <button onClick={doDelete} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: C.white, border: 'none', cursor: 'pointer', fontSize: 12, color: C.red, fontFamily: "'DM Sans',sans-serif" }}>🗑 Delete list</button>
            )}
            {msg && <div style={{ padding: '8px 12px', fontSize: 11, color: C.red, borderTop: `1px solid ${C.surface}` }}>{msg}</div>}
          </div>
        )}
      </div>

      {adding && (
        <div style={{ position: 'relative', padding: '8px 10px', borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
          <input autoFocus value={q} onChange={(e) => onQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(sugg[0]?.ticker || q); if (e.key === 'Escape') setAdding(false); }}
            placeholder="Add ticker — e.g. NVDA"
            style={{ width: '100%', height: 30, borderRadius: 6, border: `1px solid ${C.border}`, padding: '0 10px', fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: 'none', boxSizing: 'border-box' }} />
          {msg && <div style={{ fontSize: 11, color: C.red, marginTop: 5 }}>{msg}</div>}
          {sugg.length > 0 && (
            <div style={{ position: 'absolute', top: 'calc(100% - 2px)', left: 10, right: 10, zIndex: 5, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 8px 22px rgba(0,0,0,0.14)', overflow: 'hidden', maxHeight: 240, overflowY: 'auto' }}>
              {sugg.map((s, i) => (
                <button key={s.ticker + i} type="button" onMouseDown={(e) => { e.preventDefault(); add(s.ticker); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 10px', background: C.white, border: 'none', borderBottom: i < sugg.length - 1 ? `1px solid ${C.surface}` : 'none', cursor: 'pointer' }}>
                  <TickerLogo symbol={s.ticker} size={18} />
                  <span className="cp-tkr" style={{ fontSize: 12.5, fontWeight: 700, color: C.green }}>{s.ticker}</span>
                  <span style={{ fontSize: 11.5, color: C.muted, fontWeight: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        {rows === null ? (
          <div style={{ padding: 24, textAlign: 'center', color: C.dim, fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '24px 18px', textAlign: 'center', color: C.muted, fontSize: 12.5, lineHeight: 1.5 }}>
            Your watchlist is empty. Hit <b style={{ color: C.green }}>+</b> above or tap the ★ on any ticker page.
          </div>
        ) : (
          <div>
            {rows.map((r, i) => (
              <div key={r.ticker} draggable
                onDragStart={() => setDragIdx(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onDropRow(i)}
                onDragEnd={() => setDragIdx(null)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px',
                  borderTop: i ? `1px solid ${C.surface}` : 'none',
                  background: dragIdx === i ? C.surface : '#fff', opacity: dragIdx === i ? 0.5 : 1 }}>
                <span title="Drag to reorder" style={{ cursor: 'grab', color: C.dim, fontSize: 12, lineHeight: 1, userSelect: 'none', flexShrink: 0 }}>⋮⋮</span>
                <a href={`/ticker/${encodeURIComponent(r.ticker)}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none', flex: 1, minWidth: 0 }}>
                  <TickerLogo symbol={r.ticker} size={16} /><span className="cp-tkr" style={{ color: C.ink, fontWeight: 700, fontSize: 12 }}>{r.ticker}</span>
                </a>
                <span className="cp-num" style={{ fontSize: 12.5, color: C.ink, whiteSpace: 'nowrap' }}>{r.price != null ? (r.price > 1000 ? (+r.price).toLocaleString() : fmt2(+r.price)) : '—'}</span>
                <span className="cp-num" style={{ fontSize: 12.5, minWidth: 54, textAlign: 'right', whiteSpace: 'nowrap', color: r.changePct == null ? C.dim : r.changePct >= 0 ? C.green : C.red, fontWeight: 600 }}>
                  {r.changePct == null ? '—' : `${r.changePct > 0 ? '+' : ''}${fmt2(r.changePct)}%`}
                </span>
                <button onClick={() => remove(r.ticker)} aria-label={`Remove ${r.ticker}`} title="Remove"
                  style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = C.red)} onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function WatchlistDock() {
  const pathname = usePathname();
  const onTerminal = !!pathname && pathname.startsWith('/terminal');
  const { isSignedIn, isLoaded } = useUser();
  const [ready, setReady] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setReady(true);
    const mq = window.matchMedia(MOBILE_Q);
    const applyMq = () => setMobile(mq.matches);
    applyMq();
    mq.addEventListener('change', applyMq);
    let saved = null;
    try { saved = localStorage.getItem(PREF_KEY); } catch { /* private mode */ }
    setOpen(saved == null ? !mq.matches : saved === '1');   // default open on desktop
    return () => mq.removeEventListener('change', applyMq);
  }, []);

  // Reserve the panel width on the right when open (desktop + signed-in only, not on Terminal).
  const active = !!isSignedIn && !mobile && !onTerminal;
  useEffect(() => {
    document.documentElement.style.setProperty('--cp-watch', (active && open) ? `${PANEL_W}px` : '0px');
  }, [active, open]);

  const toggle = (next) => {
    const v = typeof next === 'boolean' ? next : !open;
    setOpen(v);
    try { localStorage.setItem(PREF_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };

  if (!ready || !isLoaded) return null;
  if (!isSignedIn || mobile || onTerminal) return null;   // desktop signed-in only

  return (
    <>
      <button onClick={() => toggle()} aria-label={open ? 'Collapse watchlist' : 'Open watchlist'}
        style={{ position: 'fixed', top: '25%', right: open ? PANEL_W : 0, transform: 'translateY(-50%)',
          zIndex: 61, transition: 'right 0.25s ease', display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 6, padding: '12px 7px', cursor: 'pointer',
          background: C.green, color: '#fff', border: 'none', borderRadius: '8px 0 0 8px',
          boxShadow: '-2px 0 10px rgba(0,0,0,0.12)' }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        <span style={{ writingMode: 'vertical-rl', fontSize: 10, fontWeight: 700, letterSpacing: 1.5, fontFamily: "'DM Sans',sans-serif" }}>
          WATCHLIST
        </span>
      </button>

      <div style={{ position: 'fixed', top: 0, right: 0, height: '50vh', width: PANEL_W, zIndex: 60,
        transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 0.25s ease',
        boxShadow: open ? '-8px 0 24px rgba(0,0,0,0.12)' : 'none', pointerEvents: open ? 'auto' : 'none' }}>
        {open && <Body onClose={() => toggle(false)} />}
      </div>
    </>
  );
}
