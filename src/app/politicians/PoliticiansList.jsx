'use client';
import { useState, useEffect, useCallback } from 'react';
import { C, Skel, Dot, TopNav, Footer, BrandStyles } from '../../lib/cp-shared';
import { fmtMoney, fmtDate, partyStyle, chamberLabel, Avatar, Chip, Stat } from './ui';

// ─── filter definitions ──────────────────────────────────────────────────────
const SORTS = [
  { key: 'most_active', label: 'Most Active' },
  { key: 'top_volume',  label: 'Top Volume' },
  { key: 'recent',      label: 'Most Recent' },
];
const CHAMBERS = [
  { key: '',       label: 'All' },
  { key: 'house',  label: 'House' },
  { key: 'senate', label: 'Senate' },
];
const PARTIES = [
  { key: '',            label: 'All' },
  { key: 'Democrat',    label: 'Dem' },
  { key: 'Republican',  label: 'Rep' },
  { key: 'Independent', label: 'Ind' },
];

function PillGroup({ label, options, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, color: C.dim, letterSpacing: '0.8px' }}>{label}</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {options.map((o) => {
          const active = value === o.key;
          return (
            <button key={o.key || 'all'} onClick={() => onChange(o.key)}
              style={{
                background: active ? C.green : C.white, color: active ? '#fff' : C.text,
                border: `1px solid ${active ? C.green : C.border}`, borderRadius: 6,
                padding: '6px 12px', fontSize: 12, cursor: 'pointer', transition: 'all 0.15s',
                fontFamily: "'DM Sans',sans-serif", fontWeight: active ? 600 : 400,
              }}>
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MemberCard({ m }) {
  const ps = partyStyle(m.party);
  const total = (m.buys || 0) + (m.sells || 0);
  const buyPct = total ? (m.buys / total) * 100 : 0;
  return (
    <a href={`/politicians/${m.slug}`} className="card-hov"
      style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column',
        background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, transition: 'all 0.2s' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <Avatar photoUrl={m.photoUrl} name={m.name} ps={ps} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name || 'Unknown'}</div>
          <div style={{ display: 'flex', gap: 5, marginTop: 5 }}>
            <Chip bg={ps.bg} fg={ps.fg}>{ps.abbr}</Chip>
            {m.state && <Chip bg={C.surface} fg={C.muted}>{m.state}</Chip>}
            <Chip bg={C.surface} fg={C.muted}>{chamberLabel(m.chamber)}</Chip>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <Stat label="TRADES" value={m.tradeCount} />
        <Stat label="VOLUME" value={fmtMoney(m.totalVolume)} />
        <Stat label="LAST TRADED" value={fmtDate(m.lastTraded)} small />
      </div>

      {/* buy/sell split */}
      <div>
        <div style={{ display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden', background: C.surface, marginBottom: 5 }}>
          <div style={{ width: `${buyPct}%`, background: C.greenMid }} />
          <div style={{ width: `${100 - buyPct}%`, background: C.red }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: "'DM Sans',sans-serif", fontSize: 10 }}>
          <span style={{ color: C.green }}>{m.buys || 0} buys</span>
          <span style={{ color: C.red }}>{m.sells || 0} sells</span>
        </div>
      </div>
    </a>
  );
}

export default function PoliticiansList() {
  const [members, setMembers] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('most_active');
  const [chamber, setChamber] = useState('');
  const [party, setParty] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ view });
      if (chamber) qs.set('chamber', chamber);
      if (party) qs.set('party', party);
      const res = await fetch(`/api/politicians?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setMembers(json.members || []);
    } catch (e) {
      setError(e.message); setMembers(null);
    } finally {
      setLoading(false);
    }
  }, [view, chamber, party]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Politicians" />

      {/* HEADER */}
      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: '20px 24px' }}>
        <div style={{ maxWidth: 1380, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Dot /><span style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, color: C.muted, letterSpacing: '1px' }}>STOCK ACT · HOUSE + SENATE · LIVE</span>
          </div>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 32, fontWeight: 600, color: C.ink, margin: '0 0 4px', letterSpacing: '-0.5px' }}>Politicians</h1>
          <p style={{ fontSize: 13, color: C.muted, margin: 0, fontWeight: 300 }}>Congressional stock trades disclosed under the STOCK Act. See how each trade has performed since.</p>
        </div>
      </div>

      {/* CONTROLS */}
      <div style={{ maxWidth: 1380, margin: '0 auto', padding: '16px 24px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <PillGroup label="SORT"    options={SORTS}    value={view}    onChange={setView} />
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <PillGroup label="CHAMBER" options={CHAMBERS} value={chamber} onChange={setChamber} />
          <PillGroup label="PARTY"   options={PARTIES}  value={party}   onChange={setParty} />
        </div>
      </div>

      {/* GRID */}
      <div style={{ maxWidth: 1380, margin: '16px auto', padding: '0 24px 40px' }}>
        <div style={{ fontSize: 12, color: C.dim, fontFamily: "'DM Mono',monospace", marginBottom: 12 }}>
          {loading ? 'Loading…' : error ? '' : `${members?.length || 0} members`}
        </div>

        {error ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '40px 16px', textAlign: 'center', color: C.red, fontSize: 13 }}>Failed to load: {error}</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
            {loading
              ? Array(8).fill(0).map((_, i) => (
                  <div key={i} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14 }}>
                      <div style={{ width: 52, height: 52, borderRadius: '50%', background: C.surface, flexShrink: 0 }} />
                      <div style={{ flex: 1 }}><Skel w="70%" h={14} mb={8} /><Skel w="45%" h={10} mb={0} /></div>
                    </div>
                    <Skel h={12} mb={10} /><Skel h={10} mb={0} />
                  </div>
                ))
              : (members || []).length === 0
                ? <div style={{ gridColumn: '1/-1', textAlign: 'center', color: C.muted, fontSize: 13, padding: '40px 16px' }}>No members match these filters.</div>
                : members.map((m) => <MemberCard key={m.slug} m={m} />)}
          </div>
        )}

        {/* INFO */}
        <div style={{ marginTop: 16, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '16px 20px', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 18, flexShrink: 0 }}>ℹ️</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 4 }}>About Congressional Trading Disclosures</div>
            <div style={{ fontSize: 12, color: C.muted, fontWeight: 300, lineHeight: 1.6 }}>
              Members of Congress must disclose stock transactions under the STOCK Act, typically within 45 days. Click any member to see their full trade history and how each trade has performed since. This is not financial advice.
            </div>
          </div>
        </div>
      </div>

      <Footer />
    </div>
  );
}
