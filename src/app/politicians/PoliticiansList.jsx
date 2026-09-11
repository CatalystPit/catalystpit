'use client';
import { useState, useEffect, useCallback } from 'react';
import { C, Skel, Dot, TopNav, Footer, BrandStyles, startCheckout, EntitySearch } from '../../lib/cp-shared';
import { fmtMoney, fmtDate, partyStyle, chamberLabel, Avatar, Chip, Stat, fmtReturn, returnColor } from './ui';

// ─── filter definitions ──────────────────────────────────────────────────────
const SORTS = [
  { key: 'most_active', label: 'Most Active' },
  { key: 'top_volume',  label: 'Top Volume' },
  { key: 'recent',      label: 'Most Recent' },
  { key: 'leaderboard', label: '🏆 Best Traders' },
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
const WINDOWS = [
  { key: '3m',  label: '3M' },
  { key: '6m',  label: '6M' },
  { key: '1y',  label: '1Y' },
  { key: '2y',  label: '2Y' },
  { key: 'all', label: 'All-time' },
];

function PillGroup({ label, options, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.dim, letterSpacing: '0.8px' }}>{label}</span>
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

// Ranked "Best Traders" leaderboard — size-weighted return on each member's priced purchases.
function LeaderboardTable({ members }) {
  const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`);
  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
              {[['#', 'center'], ['Member', 'left'], ['Return', 'right'], ['Win rate', 'right'], ['Priced buys', 'right'], ['Volume', 'right']].map(([h, al]) => (
                <th key={h} style={{ padding: '10px 14px', textAlign: al, fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap' }}>{h.toUpperCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => {
              const ps = partyStyle(m.party);
              return (
                <tr key={m.slug} className="hov" onClick={() => { window.location.href = `/politicians/${m.slug}`; }}
                  style={{ borderBottom: i < members.length - 1 ? `1px solid ${C.surface}` : 'none', cursor: 'pointer' }}>
                  <td style={{ padding: '12px 14px', textAlign: 'center', fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, color: C.ink, whiteSpace: 'nowrap' }}>{medal(i)}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Avatar photoUrl={m.photoUrl} name={m.name} ps={ps} size={32} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name || 'Unknown'}</span>
                        <span style={{ display: 'flex', gap: 5, marginTop: 3 }}>
                          <Chip bg={ps.bg} fg={ps.fg}>{ps.abbr}</Chip>
                          {m.state && <Chip bg={C.surface} fg={C.muted}>{m.state}</Chip>}
                          <Chip bg={C.surface} fg={C.muted}>{chamberLabel(m.chamber)}</Chip>
                        </span>
                      </span>
                    </span>
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 16, fontWeight: 700, color: returnColor(m.returnPct), whiteSpace: 'nowrap' }}>{fmtReturn(m.returnPct)}</td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: C.muted, whiteSpace: 'nowrap' }}>{m.winRate != null ? `${m.winRate}%` : '—'}</td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: C.muted, whiteSpace: 'nowrap' }}>{m.pricedBuys}</td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: C.text, whiteSpace: 'nowrap' }}>{fmtMoney(m.totalVolume)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Locked placeholder card — NO real member data (server sent none for signed-out
// users beyond the preview). Faint muted bars matching MemberCard's footprint + lock glyph.
function LockedMemberCard() {
  return (
    <div aria-hidden="true" style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
      filter: 'blur(4px)', userSelect: 'none', pointerEvents: 'none', opacity: 0.6 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: C.surface2, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, color: C.ink }}>████████ ██████</div>
          <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.muted, marginTop: 5 }}>███ · ██ · House</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 18 }}>
        <div><div style={{ fontSize: 9, color: C.dim }}>TRADES</div><div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, color: C.ink }}>██</div></div>
        <div><div style={{ fontSize: 9, color: C.dim }}>VOLUME</div><div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, color: C.ink }}>$███K</div></div>
        <div><div style={{ fontSize: 9, color: C.dim }}>LAST TRADE</div><div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, color: C.ink }}>██████</div></div>
      </div>
    </div>
  );
}

export default function PoliticiansList() {
  const [members, setMembers] = useState(null);
  const [lockedCount, setLockedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('most_active');
  const [chamber, setChamber] = useState('');
  const [party, setParty] = useState('');
  const [lbWindow, setLbWindow] = useState('1y');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ view });
      if (chamber) qs.set('chamber', chamber);
      if (party) qs.set('party', party);
      if (view === 'leaderboard') qs.set('window', lbWindow);
      const res = await fetch(`/api/politicians?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setMembers(json.members || []);
      setLockedCount(json.lockedCount || 0);   // signed-out → >0; signed-in → 0/absent
    } catch (e) {
      setError(e.message); setMembers(null); setLockedCount(0);
    } finally {
      setLoading(false);
    }
  }, [view, chamber, party, lbWindow]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Politicians" />

      {/* HEADER */}
      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: '20px 24px' }}>
        <div style={{ maxWidth: 1380, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Dot /><span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.muted, letterSpacing: '1px' }}>STOCK ACT · HOUSE + SENATE</span>
          </div>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 32, fontWeight: 600, color: C.ink, margin: '0 0 4px', letterSpacing: '-0.5px' }}>Politicians</h1>
          <p style={{ fontSize: 13, color: C.muted, margin: '0 0 14px', fontWeight: 300 }}>Congressional stock trades disclosed under the STOCK Act. See how each trade has performed since.</p>
          <EntitySearch
            endpoint="/api/politicians?ac="
            placeholder="Search a politician by name…"
            width={420}
            hrefFor={(m) => `/politicians/${m.slug}`}
            renderRow={(m) => {
              const ps = partyStyle(m.party);
              return (
                <>
                  <Avatar photoUrl={m.photoUrl} name={m.name} ps={ps} size={30} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name || 'Unknown'}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 5, flexShrink: 0 }}>
                    <Chip bg={ps.bg} fg={ps.fg}>{ps.abbr}</Chip>
                    {m.state && <Chip bg={C.surface} fg={C.muted}>{m.state}</Chip>}
                    <Chip bg={C.surface} fg={C.muted}>{chamberLabel(m.chamber)}</Chip>
                  </span>
                </>
              );
            }}
          />
        </div>
      </div>

      {/* CONTROLS */}
      <div style={{ maxWidth: 1380, margin: '0 auto', padding: '16px 24px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <PillGroup label="SORT"    options={SORTS}    value={view}    onChange={setView} />
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <PillGroup label="CHAMBER" options={CHAMBERS} value={chamber} onChange={setChamber} />
          <PillGroup label="PARTY"   options={PARTIES}  value={party}   onChange={setParty} />
          {view === 'leaderboard' && <PillGroup label="PERIOD" options={WINDOWS} value={lbWindow} onChange={setLbWindow} />}
        </div>
      </div>

      {/* GRID */}
      <div style={{ maxWidth: 1380, margin: '16px auto', padding: '0 24px 40px' }}>
        <div style={{ fontSize: 12, color: C.dim, fontFamily: "'DM Sans',sans-serif", marginBottom: 12 }}>
          {loading ? 'Loading…' : error ? '' : `${members?.length || 0} members`}
        </div>

        {view === 'leaderboard' && !loading && !error && (members || []).length > 0 && (
          <div style={{ fontSize: 12, color: C.muted, fontWeight: 300, margin: '-4px 0 12px', lineHeight: 1.5 }}>
            Size-weighted return on each member&apos;s <strong style={{ fontWeight: 600 }}>purchases</strong> {lbWindow === 'all' ? 'across all disclosed history' : `made in the last ${(WINDOWS.find((w) => w.key === lbWindow) || {}).label}`}, held to today&apos;s price — as if you copied their buys. Minimum 5 priced buys. Not financial advice.
          </div>
        )}

        {error ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '40px 16px', textAlign: 'center', color: C.red, fontSize: 13 }}>Failed to load: {error}</div>
        ) : loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
            {Array(8).fill(0).map((_, i) => (
              <div key={i} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ width: 52, height: 52, borderRadius: '50%', background: C.surface, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}><Skel w="70%" h={14} mb={8} /><Skel w="45%" h={10} mb={0} /></div>
                </div>
                <Skel h={12} mb={10} /><Skel h={10} mb={0} />
              </div>
            ))}
          </div>
        ) : (members || []).length === 0 ? (
          <div style={{ textAlign: 'center', color: C.muted, fontSize: 13, padding: '40px 16px' }}>No members match these filters.</div>
        ) : view === 'leaderboard' ? (
          <LeaderboardTable members={members} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
            {members.map((m) => <MemberCard key={m.slug} m={m} />)}
          </div>
        )}

        {/* Locked members — blurred teaser with the Pro unlock card overlaid on top. */}
        {!loading && !error && lockedCount > 0 && (
          <div style={{ position: 'relative', marginTop: 14, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
              {Array.from({ length: 6 }).map((_, i) => <LockedMemberCard key={`lock-${i}`} />)}
            </div>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(245,246,243,0.6)', padding: 16 }}>
              <div style={{ background: C.white, border: `1px solid ${C.greenBorder}`, borderRadius: 10, padding: '16px 22px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', justifyContent: 'center', boxShadow: '0 6px 24px rgba(0,0,0,0.12)', textAlign: 'center' }}>
                <span style={{ fontSize: 20 }}>🔒</span>
                <div>
                  <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 700, color: C.ink }}>{lockedCount.toLocaleString()} more members</div>
                  <div style={{ fontSize: 12, color: C.muted, fontWeight: 300 }}>Unlock every member&apos;s trades with Pro</div>
                </div>
                <button onClick={() => startCheckout()} style={{ background: C.green, color: '#fff', border: 'none', whiteSpace: 'nowrap', padding: '10px 18px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
                  Unlock Pro — $12/mo
                </button>
              </div>
            </div>
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
