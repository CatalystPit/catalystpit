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

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body style={{ margin: 0, padding: 0 }}>
        {children}
      </body>
    </html>
  )
}
