// One-off verification of insider_trades end state. Run:
//   node --env-file=.env.local scripts/verify-insiders.mjs
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';

const db = drizzle(neon(process.env.DATABASE_URL));

const total   = await db.execute(sql`SELECT COUNT(*) AS n FROM insider_trades`);
const tickers = await db.execute(sql`SELECT COUNT(DISTINCT ticker) AS n FROM insider_trades`);
const dates   = await db.execute(sql`SELECT MIN(filing_date) AS min, MAX(filing_date) AS max FROM insider_trades`);
const action  = await db.execute(sql`SELECT action, COUNT(*) AS n FROM insider_trades GROUP BY action ORDER BY n DESC`);
const top     = await db.execute(sql`SELECT ticker, COUNT(*) AS n FROM insider_trades GROUP BY ticker ORDER BY n DESC LIMIT 8`);
const spot    = await db.execute(sql`SELECT ticker, COUNT(*) AS n FROM insider_trades WHERE ticker IN ('NVDA','TSLA','AAPL','MSFT','CRWV','ASML') GROUP BY ticker ORDER BY ticker`);

const rows = (r) => r.rows ?? r;
console.log('total rows:        ', rows(total)[0].n);
console.log('distinct tickers:  ', rows(tickers)[0].n);
console.log('filing_date range: ', rows(dates)[0].min, '→', rows(dates)[0].max);
console.log('by action:         ', rows(action).map(r => `${r.action}=${r.n}`).join('  '));
console.log('top 8 tickers:     ', rows(top).map(r => `${r.ticker}:${r.n}`).join('  '));
console.log('spot-check:        ', rows(spot).map(r => `${r.ticker}:${r.n}`).join('  '));
