'use client';
// TEMP preview harness for Step 3 — renders <BullsBears> in isolation so it can be eyeballed
// on the deploy WITHOUT wiring into the Overview tab (that's Step 4). Remove before merge.
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { C } from '../../lib/cp-shared';
import BullsBears from '../../components/BullsBears';

function Inner() {
  const params = useSearchParams();
  const ticker = (params.get('ticker') || 'AAPL').toUpperCase();
  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, minHeight: '100vh', padding: '32px 16px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, color: C.dim, marginBottom: 4 }}>
          TEMP PREVIEW — /bulls-bears-preview?ticker={ticker} (remove before merge)
        </div>
        <BullsBears ticker={ticker} />
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}
