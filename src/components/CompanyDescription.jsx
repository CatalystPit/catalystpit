'use client';
import { useId, useState } from 'react';
import { C } from '../lib/cp-shared';
import {
  normalizeDescription, descriptionParagraphs, descriptionView, DESCRIPTION_CLAMP_LINES,
} from '../lib/company-description.mjs';

// The About card's company description. Renders NOTHING when there is no real description, so the
// card never shows an empty heading, "null" or a placeholder.
//
// PLAIN TEXT ONLY. The text is normalised in company-description.mjs and rendered as React text
// nodes; there is no dangerouslySetInnerHTML anywhere on this path.
//
// COLLAPSED BY A CSS LINE CLAMP, NOT BY CUTTING THE STRING. The whole description is in the markup
// in both states, so a server render carries the full text and expanding needs no refetch.
export default function CompanyDescription({ text }) {
  const clean = normalizeDescription(text);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (!clean) return null;
  const view = descriptionView(clean, expanded);

  return (
    <div data-cp-company-description="">
      <div style={{ fontSize: 12, color: C.muted, padding: '9px 0 6px' }}>Description</div>
      <div id={id} data-clamped={view.clamped ? 'true' : 'false'}
        style={{
          fontFamily: "'DM Sans',sans-serif", fontSize: 13, lineHeight: 1.6, color: C.ink,
          overflowWrap: 'anywhere',
          ...(view.clamped ? {
            display: '-webkit-box', WebkitBoxOrient: 'vertical',
            WebkitLineClamp: DESCRIPTION_CLAMP_LINES, overflow: 'hidden',
          } : {}),
        }}>
        {descriptionParagraphs(clean).map((para, i) => (
          <p key={i} style={{ margin: i === 0 ? 0 : '10px 0 0' }}>{para}</p>
        ))}
      </div>
      {view.control && (
        <button type="button" aria-expanded={expanded} aria-controls={id}
          onClick={() => setExpanded((v) => !v)}
          style={{ marginTop: 6, padding: 0, background: 'transparent', border: 'none', cursor: 'pointer',
            color: C.green, fontSize: 12, fontFamily: "'DM Sans',sans-serif", fontWeight: 500 }}>
          {view.control}
        </button>
      )}
    </div>
  );
}
