'use client';

// PIT SCAN — the standalone page.
//
// The boards have existed and been reachable only from a Terminal panel. A trader will not dig for
// a panel, so this puts all three on one page. It is an ARRANGEMENT, not a second product: the same
// /api/scan-board, the same ScanBoard component, the same compact row. Forking the row design would
// give us two things to keep in step and, eventually, two different answers.
//
// ⚠️ THE FEED STATE IS STATED ONCE AT THE TOP AND AGAIN ON EVERY ROW. Realtime is not entitled, so
// what these boards show is the last completed session. A page headed "what is moving right now"
// that quietly showed yesterday's move would be the one failure this scanner was built to refuse.

import { useState } from 'react';
import { C, BrandStyles, TopNav, Footer } from '../../lib/cp-shared';
import { ScanBoard, FeedBanner, BOARD_TABS, useScanBoards } from '../../components/scan/ScanBoardRows';

// ⚠️ A THIN WRAPPER, NOT A SECOND SCAN. Pit Scan's home is the Terminal panel; this page exists so
// the boards are linkable and readable full-width. It imports the same boards, the same banner and
// the same compact row — there is no second Scan UI to keep in step.

export default function ScanClient() {
  // Whichever board answers first sets the banner; they all read the same feed.
  const [freshness, setFreshness] = useState(null);
  // ⚠️ ONE REQUEST FOR ALL THREE. This page stacks the boards, so it used to make three requests
  // that each resolved the entitlement, read the published board and fetched the same hundred
  // quotes. They are three views of one dataset and they now arrive as one.
  const { boards, error, loading, retry } = useScanBoards();

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Scan" />

      <div style={{ maxWidth: 900, margin: '22px auto', padding: '0 20px 48px' }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600,
          color: C.ink, margin: '0 0 2px' }}>Pit Scan</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 14px', fontWeight: 300, maxWidth: 640 }}>
          What is moving, and what the public evidence says about it. Pit Consensus answers what the
          evidence means; this answers what price is doing about it.
        </p>

        <FeedBanner freshness={freshness} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          {BOARD_TABS.map((b) => (
            <section key={b.key}>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.6px', color: C.ink }}>
                  {b.label.toUpperCase()}
                </div>
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{b.blurb}</div>
              </div>
              {/* An empty board renders as an empty board with its own explanation — never hidden,
                  and never padded with rows that do not qualify. Divergence is deliberately tight. */}
              <ScanBoard board={b.key} data={boards?.[b.key] || null} loading={loading}
                errorText={error} onRetry={retry}
                onState={(j) => { if (j?.freshness) setFreshness(j.freshness); }} />
            </section>
          ))}
        </div>

        <div style={{ marginTop: 26, fontSize: 10.5, color: C.dim, lineHeight: 1.6 }}>
          Evidence accounting, not a prediction. No score, no target, no recommendation. Volume-based
          measures are unavailable on the current market-data entitlement and are omitted rather
          than estimated.
        </div>
      </div>

      <Footer />
    </div>
  );
}
