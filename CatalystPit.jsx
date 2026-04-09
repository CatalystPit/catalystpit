export const metadata = {
  title: 'CatalystPit — Live Market Intelligence',
  description: 'Every catalyst. Before the bell. Real-time charts, insider trades, politician buys, AI-powered news and your daily morning brief.',
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
        <link rel="preconnect" href="https://fonts.googleapis.com"/>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/>
        <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,600;1,600&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
      </head>
      <body style={{ margin: 0, padding: 0, background: '#F5F6F3' }}>
        {children}
      </body>
    </html>
  )
}
