'use client';

import { useEffect, useState } from 'react';
import { C, BrandStyles, TopNav, Footer } from '../../../lib/cp-shared';

const HANDLE_MAX = 20, BIO_MAX = 280;
const field = { width: '100%', padding: '10px 12px', borderRadius: 6, border: `1px solid ${C.border}`,
  fontSize: 14, fontFamily: "'DM Sans',sans-serif", outline: 'none', color: C.ink, boxSizing: 'border-box' };
const label = { fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 6, display: 'block' };

const ERRORS = { invalid_handle: 'Handle must be 3–20 chars: letters, numbers, underscores.', handle_taken: 'That handle is taken.' };

export default function ProfileEditor() {
  const [state, setState] = useState('loading'); // loading | ready | signedout
  const [form, setForm] = useState({ handle: '', displayName: '', bio: '', xHandle: '', igHandle: '', showWatchlist: false });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/profile', { cache: 'no-store' });
        if (r.status === 401) { setState('signedout'); return; }
        const j = await r.json();
        const p = j.profile || {};
        setForm({
          handle: p.handle || '', displayName: p.displayName || '', bio: p.bio || '',
          xHandle: p.xHandle || '', igHandle: p.igHandle || '', showWatchlist: !!p.showWatchlist,
        });
        setState('ready');
      } catch { setState('ready'); }
    })();
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const normHandle = form.handle.toLowerCase().replace(/[^a-z0-9_]/g, '');

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      const r = await fetch('/api/profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!r.ok) { setMsg(ERRORS[j.error] || 'Could not save.'); }
      else { setForm((f) => ({ ...f, handle: j.profile.handle })); setMsg('Saved.'); }
    } catch { setMsg('Could not save.'); }
    setSaving(false);
  };

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav />
      <div style={{ maxWidth: 560, margin: '24px auto', padding: '0 24px 48px' }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600, color: C.ink, margin: '0 0 4px' }}>Your profile</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 20px', fontWeight: 300 }}>
          This is how you show up in The Pit and across CatalystPit.
        </p>

        {state === 'signedout' && (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '32px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 10 }}>Sign in to set up your profile</div>
            <a href="/sign-in" style={{ background: C.green, color: '#fff', textDecoration: 'none', padding: '10px 20px', borderRadius: 6, fontSize: 13, fontWeight: 600 }}>Sign in</a>
          </div>
        )}

        {state === 'ready' && (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={label}>Username (this is your profile link)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 14, color: C.dim }}>@</span>
                <input value={form.handle} onChange={set('handle')} maxLength={HANDLE_MAX} placeholder="yourusername" style={field} />
              </div>
              <div style={{ marginTop: 8, padding: '8px 10px', background: C.greenLight, border: `1px solid ${C.greenBorder}`,
                borderRadius: 6, fontSize: 12, color: C.muted }}>
                Your profile lives at:{' '}
                <span style={{ color: C.green, fontWeight: 700 }}>catalystpit.com/u/{normHandle || 'yourusername'}</span>
              </div>
            </div>

            <div>
              <label style={label}>Display name (how your name shows on posts, not your link)</label>
              <input value={form.displayName} onChange={set('displayName')} maxLength={60} placeholder="e.g. The Pit" style={field} />
            </div>

            <div>
              <label style={label}>Bio</label>
              <textarea value={form.bio} onChange={set('bio')} maxLength={BIO_MAX} rows={3} placeholder="A line about your style, focus, edge…"
                style={{ ...field, resize: 'vertical' }} />
              <div style={{ fontSize: 11, color: C.dim, marginTop: 4, textAlign: 'right' }}>{form.bio.length}/{BIO_MAX}</div>
            </div>

            <div>
              <label style={label}>X handle (optional)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 14, color: C.dim }}>@</span>
                <input value={form.xHandle} onChange={set('xHandle')} maxLength={30} placeholder="yourX" style={field} />
              </div>
            </div>

            <div>
              <label style={label}>Instagram handle (optional)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 14, color: C.dim }}>@</span>
                <input value={form.igHandle} onChange={set('igHandle')} maxLength={30} placeholder="yourIG" style={field} />
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.showWatchlist} onChange={set('showWatchlist')} style={{ width: 16, height: 16 }} />
              <span style={{ fontSize: 13, color: C.text }}>Show my watchlist on my public profile</span>
            </label>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <button onClick={save} disabled={saving}
                style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 6, padding: '11px 22px',
                  fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving…' : 'Save profile'}
              </button>
              {form.handle && <a href={`/u/${form.handle.toLowerCase().replace(/[^a-z0-9_]/g, '')}`} style={{ fontSize: 13, color: C.green, textDecoration: 'none', fontWeight: 600 }}>View my profile →</a>}
              {msg && <span style={{ fontSize: 12, color: msg === 'Saved.' ? C.green : C.red }}>{msg}</span>}
            </div>
          </div>
        )}
      </div>
      <Footer />
    </div>
  );
}
