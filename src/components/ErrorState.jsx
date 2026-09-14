'use client';

import { C } from '../lib/cp-shared';

// A LOAD FAILURE IS NOT AN EMPTY RESULT. Every data page already had an empty state, and on an API
// failure it fell through to that same empty state — so "the request broke" and "there is nothing
// here today" looked identical, and a reader concluded the product was empty rather than that
// something had gone wrong. This is the other branch, and pages pick between them on whether the
// fetch actually failed, never on the length of the result.
//
// Deliberately plain: one line of what happened, one action to retry, one way home. No stack, no
// status code, no internal message — the caller passes a human sentence or takes the default.
export default function ErrorState({
  title = "Couldn't load this",
  message = 'Something went wrong on our end. Your data is fine — this is a display problem.',
  onRetry = null,
  compact = false,
}) {
  return (
    <div
      role="alert"
      style={{
        background: C.white,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: compact ? '20px 18px' : '36px 24px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
      }}
    >
      {/* A small red rule rather than an illustration — the rest of the app signals state with
          colour and type, not imagery, and an error card should not be the loudest thing on screen. */}
      <div style={{ width: 28, height: 3, borderRadius: 2, background: C.red, marginBottom: 2 }} />
      <div style={{
        fontFamily: "'DM Sans',sans-serif", fontSize: compact ? 14 : 17, fontWeight: 600, color: C.ink,
      }}>
        {title}
      </div>
      <p style={{
        margin: 0, maxWidth: 420, fontSize: compact ? 12 : 13, lineHeight: 1.6,
        color: C.muted, fontWeight: 300,
      }}>
        {message}
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            style={{
              background: C.green, color: '#FFFFFF', border: 'none', borderRadius: 6,
              padding: compact ? '7px 16px' : '9px 20px', fontSize: 13, fontWeight: 600,
              fontFamily: "'DM Sans',sans-serif", cursor: 'pointer',
            }}
          >
            Try again
          </button>
        )}
        <a
          href="/"
          style={{
            background: 'transparent', color: C.muted, border: `1px solid ${C.border2}`, borderRadius: 6,
            padding: compact ? '7px 16px' : '9px 20px', fontSize: 13, fontWeight: 500,
            fontFamily: "'DM Sans',sans-serif", textDecoration: 'none',
          }}
        >
          Go to homepage
        </a>
      </div>
    </div>
  );
}
