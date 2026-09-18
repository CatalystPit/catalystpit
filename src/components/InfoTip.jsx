'use client';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { C } from '../lib/cp-shared';
import { placeFor } from '../lib/chart/chart-popover.mjs';

// THE SMALL "i" THAT EXPLAINS A COLUMN.
//
// One implementation, everywhere. This started as a private helper inside the Insiders page; the
// Dividend Calendar needed eight of them, and eight copies of a tooltip is how eight tooltips end up
// behaving eight different ways.
//
// THREE THINGS THE PRIVATE VERSION GOT WRONG, all of which are the point of this file:
//
//   CLIPPING. It was absolutely positioned inside the trigger, so a tooltip on the rightmost column
//   of a table ran off the screen, and one inside a horizontally-scrolling table was clipped by the
//   scroll container itself. It is now PORTALLED to the body and placed in viewport coordinates by
//   placeFor — the same tested geometry the chart's menus use, which flips and clamps so the box
//   always lands inside the window.
//
//   TOUCH. Hover does not exist on a phone. Click and tap toggle it, an outside tap closes it, and
//   the panel itself swallows clicks so tapping the text does not immediately dismiss it.
//
//   KEYBOARD. The trigger is a real <button> in the tab order, labelled with the column it explains.
//   Focus opens it, Escape and blur close it, and the panel is wired with aria-describedby so a
//   screen reader reads the explanation rather than announcing an unlabelled "i".
//
// A CLOSE DELAY, not an instant one: the tooltip stays up for a moment after the pointer leaves, so
// it can be read, and so the pointer can travel onto it without the text vanishing mid-journey.

const CLOSE_DELAY_MS = 220;

export default function InfoTip({ title, body, label, width = 270, placement = 'bottom-center' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const anchor = useRef(null);
  const closeTimer = useRef(null);
  const id = useId();

  const cancelClose = useCallback(() => clearTimeout(closeTimer.current), []);
  const closeSoon = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancelClose]);
  const closeNow = useCallback(() => { cancelClose(); setOpen(false); }, [cancelClose]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const place = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setPos(placeFor(rect, placement, { gap: 6, width, maxHeight: 260 }));
  }, [placement, width]);

  // Placed before paint, so the tooltip never appears at the wrong spot and then jumps.
  useLayoutEffect(() => { if (open) place(); else setPos(null); }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { closeNow(); anchor.current?.focus(); } };
    const onDown = (e) => { if (!anchor.current?.contains(e.target)) closeNow(); };
    // Capture phase catches a scrolling ANCESTOR too — the dividend table scrolls horizontally, and
    // the tooltip has to follow its icon rather than hang in space where the icon used to be.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, place, closeNow]);

  // STOP EVERY EVENT AT THE TRIGGER. The dividend headers sort on click and the insider heatmap
  // navigates; an info icon inside one of those must not also fire it.
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={label ? `What does ${label} mean?` : 'More information'}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={(e) => { swallow(e); cancelClose(); setOpen((s) => !s); }}
        onPointerDown={swallow}
        onMouseEnter={() => { cancelClose(); setOpen(true); }}
        onMouseLeave={closeSoon}
        onFocus={() => { cancelClose(); setOpen(true); }}
        onBlur={closeSoon}
        style={{
          appearance: 'none', margin: 0, padding: 0, marginLeft: 4,
          width: 13, height: 13, flex: '0 0 auto',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontWeight: 700, lineHeight: 1, fontFamily: "'DM Sans',sans-serif",
          // Themed from the design tokens, so light and dark both work with no second stylesheet.
          color: C.dim, background: 'transparent', border: `1px solid ${C.border}`,
          borderRadius: '50%', cursor: 'help', verticalAlign: 'middle',
          textTransform: 'none', letterSpacing: 0,
        }}
      >i</button>

      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          id={id}
          role="tooltip"
          onMouseEnter={cancelClose}
          onMouseLeave={closeSoon}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: pos.top, left: pos.left, right: pos.right, bottom: pos.bottom,
            width: pos.width, maxHeight: pos.maxHeight, overflowY: 'auto',
            zIndex: 200,
            background: C.white, border: `1px solid ${C.border}`, borderRadius: 7,
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            padding: '9px 11px',
            fontFamily: "'DM Sans',sans-serif", textAlign: 'left',
            // The trigger lives in a header styled uppercase, bold and letter-spaced. Without these
            // the explanation inherits all three and reads as shouting.
            textTransform: 'none', letterSpacing: 'normal',
          }}
        >
          {title && (
            <div style={{ fontSize: 11.5, fontWeight: 700, color: C.ink ?? C.text, marginBottom: 3 }}>{title}</div>
          )}
          <div style={{ fontSize: 11, fontWeight: 400, lineHeight: 1.5, color: C.muted }}>{body}</div>
        </div>,
        document.body,
      )}
    </>
  );
}
