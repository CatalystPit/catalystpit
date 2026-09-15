import { ImageResponse } from 'next/og';

// Served at /icon and linked automatically by Next. There was no favicon at all — the root layout
// pointed at /favicon.ico and this repository has no public/ directory, so it 404'd on every page.
//
// This is NOT a new mark. It is the existing wordmark's "Pit" half — the same Cormorant Garamond
// italic P on the same brand green (#1E5C38) that Logo in cp-shared already draws — cropped to a
// square, which is all a favicon can show at 32px. Nothing about the logo is redesigned.
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: '#1E5C38', color: '#FFFFFF',
          fontSize: 24, fontWeight: 700, fontStyle: 'italic',
          fontFamily: 'Georgia, "Times New Roman", serif',
          letterSpacing: '-0.02em',
        }}
      >
        P
      </div>
    ),
    { ...size },
  );
}
