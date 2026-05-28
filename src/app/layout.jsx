import { ClerkProvider } from '@clerk/nextjs';

export const metadata = {
  title: 'CatalystPit — Live Market Intelligence',
  description: 'Every catalyst. Before the bell. Real-time charts, insider trades, politician buys, AI-powered news and your morning brief.',
  keywords: 'market intelligence, insider trading, politician trades, stock screener, options flow, financial news',
  openGraph: {
    title: 'CatalystPit — Live Market Intelligence',
    description: 'Every catalyst. Before the bell.',
    url: 'https://catalystpit.com',
    siteName: 'CatalystPit',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CatalystPit — Live Market Intelligence',
    description: 'Every catalyst. Before the bell.',
    creator: '@CatalystPit',
  },
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <head>
          <link rel="icon" href="/favicon.ico" />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,500;0,600;1,600;1,700&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" />
          <style>{`
            .cp-num {
              font-family: 'Inter', sans-serif !important;
              font-weight: 600 !important;
              font-variant-numeric: tabular-nums !important;
            }
            .cp-tkr {
              font-family: 'Inter', sans-serif !important;
              font-weight: 700 !important;
              letter-spacing: 0.02em !important;
            }
            .cp-body-grid {
              max-width: 1380px;
              margin: 0 auto;
              padding: 16px 24px;
              display: grid;
              grid-template-columns: minmax(0, 1fr) 300px;
              gap: 16px;
            }
            @media (max-width: 860px) {
              .cp-body-grid { grid-template-columns: minmax(0, 1fr); }
            }
          `}</style>
        </head>
        <body style={{ margin: 0, padding: 0 }}>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
