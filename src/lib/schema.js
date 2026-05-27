import { pgTable, serial, text, doublePrecision, date, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const insiderTrades = pgTable('insider_trades', {
  id:               serial('id').primaryKey(),
  ticker:           text('ticker').notNull(),
  company:          text('company'),
  executive:        text('executive'),
  title:            text('title'),
  transactionCode:  text('transaction_code'),
  action:           text('action').notNull(),
  shares:           doublePrecision('shares').notNull().default(0),
  pricePerShare:    doublePrecision('price_per_share').notNull().default(0),
  totalValue:       doublePrecision('total_value').notNull().default(0),
  sharesOwnedAfter: doublePrecision('shares_owned_after'),
  securityTitle:    text('security_title'),
  transactionDate:  date('transaction_date', { mode: 'string' }),
  filingDate:       date('filing_date',      { mode: 'string' }).notNull(),
  accession:        text('accession').notNull(),
  filingUrl:        text('filing_url'),
  insertedAt:       timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqTxn: uniqueIndex('uq_insider_txn').on(
    t.accession, t.transactionDate, t.transactionCode,
    t.securityTitle, t.shares, t.pricePerShare, t.sharesOwnedAfter,
  ),
  idxTicker:           index('idx_insider_ticker').on(t.ticker),
  idxFilingDate:       index('idx_insider_filing_date').on(t.filingDate),
  idxTickerFilingDate: index('idx_insider_ticker_filing').on(t.ticker, t.filingDate),
  idxTransactionDate:  index('idx_insider_transaction_date').on(t.transactionDate),
}));
