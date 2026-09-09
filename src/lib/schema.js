import { pgTable, serial, text, integer, boolean, doublePrecision, date, timestamp, uniqueIndex, index, primaryKey } from 'drizzle-orm/pg-core';

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
  idxActionFiling:     index('idx_insider_action_filing').on(t.action, t.filingDate),
}));

export const eightkFilings = pgTable('eightk_filings', {
  id:            serial('id').primaryKey(),
  ticker:        text('ticker').notNull(),
  company:       text('company'),
  cik:           text('cik').notNull(),
  items:         text('items'),                          // CSV of item codes, e.g. "2.02,9.01"
  material:      boolean('material').notNull().default(false),
  primaryDocUrl: text('primary_doc_url'),
  filingUrl:     text('filing_url'),                     // EDGAR index page
  reportDate:    date('report_date', { mode: 'string' }),
  accession:     text('accession').notNull(),
  filedAt:       timestamp('filed_at', { withTimezone: true }).notNull(),
  insertedAt:    timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqAcc:        uniqueIndex('uq_eightk_accession').on(t.accession),
  idxFiledAt:   index('idx_eightk_filed_at').on(t.filedAt),
  idxMaterial:  index('idx_eightk_material_filed').on(t.material, t.filedAt),
  idxTicker:    index('idx_eightk_ticker').on(t.ticker),
}));

export const congressTrades = pgTable('congress_trades', {
  id:               serial('id').primaryKey(),
  txHash:           text('tx_hash').notNull(),            // sha256 synthetic dedup key

  chamber:          text('chamber').notNull(),            // 'senate' | 'house'

  // member identity — raw from FMP feed
  firstName:        text('first_name'),
  lastName:         text('last_name'),
  representative:   text('representative'),                // full display name
  // member identity — resolved from roster (denormalized, not per-request)
  memberSlug:       text('member_slug'),                  // bioguide id, else name-slug; null if unmatched
  party:            text('party'),
  state:            text('state'),                         // 2-letter
  district:         text('district'),                      // raw "NJ07" / ""

  // asset + transaction
  ticker:           text('ticker'),                        // null when blank / non-equity
  assetDescription: text('asset_description'),
  assetType:        text('asset_type'),
  owner:            text('owner'),                          // Self | Spouse | Joint | ''
  type:             text('type'),                           // raw "Sale" | "Purchase" | ...
  action:           text('action').notNull(),               // normalized BUY | SELL | EXCHANGE | OTHER
  amountRange:      text('amount_range'),                   // raw "$1,001 - $15,000"
  amountMin:        doublePrecision('amount_min'),
  amountMax:        doublePrecision('amount_max'),           // null if open-ended
  amountMid:        doublePrecision('amount_mid'),           // midpoint → volume/sort

  transactionDate:  date('transaction_date', { mode: 'string' }),
  disclosureDate:   date('disclosure_date',  { mode: 'string' }).notNull(),
  filingLagDays:    integer('filing_lag_days'),             // disclosure - transaction
  capGainsOver200:  boolean('cap_gains_over_200'),           // house only
  comment:          text('comment'),
  link:             text('link'),                            // source filing URL

  // enrichment — return-since-trade
  priceAtTrade:     doublePrecision('price_at_trade'),       // Tiingo EOD raw close on/near txn date (immutable once set)
  priceAtTradeDate: date('price_at_trade_date', { mode: 'string' }),  // actual trading day used
  enrichedAt:       timestamp('enriched_at', { withTimezone: true }),

  insertedAt:       timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqTx:        uniqueIndex('uq_congress_tx').on(t.txHash),
  idxMember:   index('idx_congress_member').on(t.memberSlug),
  idxDisclose: index('idx_congress_disclosure').on(t.disclosureDate),
  idxTicker:   index('idx_congress_ticker').on(t.ticker),
  idxTxnDate:  index('idx_congress_txn_date').on(t.transactionDate),
}));

export const congressTickerPrices = pgTable('congress_ticker_prices', {
  ticker:       text('ticker').primaryKey(),
  currentPrice: doublePrecision('current_price'),           // Finnhub /quote latest
  asOfDate:     date('as_of_date', { mode: 'string' }),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Permanent cache of daily EOD candles for the ticker price chart (1M+ timeframes).
// Stores SPLIT/DIVIDEND-ADJUSTED OHLCV (mapped from Tiingo adj* fields on insert) so
// historical charts have no split-induced discontinuities. Past dates are immutable —
// once stored, never re-fetched; only today's row is refreshed post-close. The composite
// PK (ticker, date) btree serves the sole query: range scan per ticker ordered by date.
export const tickerDailyCandles = pgTable('ticker_daily_candles', {
  ticker:  text('ticker').notNull(),
  date:    date('date', { mode: 'string' }).notNull(),
  open:    doublePrecision('open').notNull(),               // = Tiingo adjOpen
  high:    doublePrecision('high').notNull(),               // = Tiingo adjHigh
  low:     doublePrecision('low').notNull(),                // = Tiingo adjLow
  close:   doublePrecision('close').notNull(),              // = Tiingo adjClose
  volume:  doublePrecision('volume').notNull().default(0),  // = Tiingo adjVolume (fractional after splits)
  source:  text('source').notNull().default('tiingo'),
}, (t) => ({
  pk: primaryKey({ columns: [t.ticker, t.date] }),
}));

// FINRA bi-monthly consolidated short interest (consolidatedShortInterest API).
// One row per (settlement_date, ticker). changePercent + prevShortIntShares come
// straight from the feed, so the tab's "change from prior period" needs no compute.
// ETFs ARE included in this dataset (SPY/QQQ confirmed) — not an empty-state case.
export const shortInterest = pgTable('short_interest', {
  settlementDate:    date('settlement_date', { mode: 'string' }).notNull(),
  ticker:            text('ticker').notNull(),
  shortIntShares:    doublePrecision('short_int_shares'),       // currentShortPositionQuantity
  prevShortIntShares: doublePrecision('prev_short_int_shares'), // previousShortPositionQuantity
  avgDailyVolume:    doublePrecision('avg_daily_volume'),       // averageDailyVolumeQuantity
  daysToCover:       doublePrecision('days_to_cover'),          // daysToCoverQuantity
  changePercent:     doublePrecision('change_percent'),         // changePercent (feed-provided)
  marketCenter:      text('market_center'),                     // marketClassCode
  issueName:         text('issue_name'),
  source:            text('source').notNull().default('finra'),
}, (t) => ({
  pk:           primaryKey({ columns: [t.settlementDate, t.ticker] }),
  idxTicker:    index('idx_short_interest_ticker').on(t.ticker),
  idxSettlement: index('idx_short_interest_settlement').on(t.settlementDate),
}));

// Free-float share counts (FMP /stable/shares-float, SEC-sourced). Lazily filled
// by /api/short-interest on first view of a ticker, refreshed when stale (~30d).
// floatShares is the correct denominator for "% of float" (excludes restricted/insider
// shares); 0/null when FMP has no float (e.g. ETFs) → UI renders "—".
export const tickerFloat = pgTable('ticker_float', {
  ticker:            text('ticker').primaryKey(),
  floatShares:       doublePrecision('float_shares'),
  outstandingShares: doublePrecision('outstanding_shares'),
  freeFloatPct:      doublePrecision('free_float_pct'),
  source:            text('source').notNull().default('fmp'),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Per-user watchlist: association of Clerk user → ticker → when added.
// Static membership only (v1) — no price/notes/ordering columns; prices are
// fetched live by the workspace (M5), not stored here. The unique (user_id,
// ticker) index is BOTH the idempotency guard (a user can't add the same
// symbol twice — INSERT ... ON CONFLICT DO NOTHING) AND the user-lookup index:
// its leading user_id column backs the hot query "all tickers for this user".
export const watchlist = pgTable('watchlist', {
  id:       serial('id').primaryKey(),
  userId:   text('user_id').notNull(),       // Clerk user ID — row owner
  ticker:   text('ticker').notNull(),        // uppercase symbol (enforced in API)
  listId:   integer('list_id'),              // which named list (null → user's default, backfilled lazily)
  position: integer('position'),             // user drag-order within the list (null → sort by addedAt)
  addedAt:  timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqUserTicker: uniqueIndex('uq_watchlist_user_ticker').on(t.userId, t.ticker),
}));

// Named watchlists (multiple = Pro perk). A user's tickers each belong to one list (v1: a ticker
// lives in exactly one list; adding it elsewhere moves it). is_default = the list the ticker-page ★
// and legacy surfaces (homepage/Terminal) read/write.
export const watchlistLists = pgTable('watchlist_lists', {
  id:        serial('id').primaryKey(),
  userId:    text('user_id').notNull(),
  name:      text('name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  position:  integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxUser: index('idx_watchlist_lists_user').on(t.userId),
}));

// ── 13F institutional holdings (Institutions feature) ────────────────────────
// One row per reported position, per manager (CIK), per quarter. `ticker` resolved from
// `cusip` at ingest (OpenFIGI, best-effort/bounded) — null until resolved; `issuer` (from the
// filing) is always present so the UI never renders blank. `value` normalized to whole USD
// (13F reported value in $thousands before 2023, whole dollars after — ingestion handles it).
export const fundHoldings = pgTable('fund_holdings', {
  id:         serial('id').primaryKey(),
  cik:        text('cik').notNull(),
  quarter:    date('quarter', { mode: 'string' }).notNull(),   // period-of-report end (e.g. 2025-06-30)
  cusip:      text('cusip').notNull(),
  ticker:     text('ticker'),
  issuer:     text('issuer'),
  cls:        text('class').notNull().default(''),             // title of class
  shares:     doublePrecision('shares'),
  value:      doublePrecision('value'),                        // USD market value (whole dollars)
  putCall:    text('put_call').notNull().default(''),          // 'Put' | 'Call' | ''
  filedDate:  date('filed_date', { mode: 'string' }),
  insertedAt: timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uq:        uniqueIndex('uq_fund_holding').on(t.cik, t.quarter, t.cusip, t.cls, t.putCall),
  idxFundQ:  index('idx_fund_holdings_cik_quarter').on(t.cik, t.quarter),
  idxTicker: index('idx_fund_holdings_ticker').on(t.ticker),
  idxCusip:  index('idx_fund_holdings_cusip').on(t.cusip),
}));

// ── The Pit — Pro members' live chat (community feature) ─────────────────────
// One row per message. Identity (username/avatar/tier) is SNAPSHOTTED at post time so
// history renders correctly even if a user later changes their name or lapses from Pro.
// Reads are open to everyone; posting is Pro/Elite-only, enforced in /api/pit/messages.
// `deleted` is a soft-delete flag (admin moderation) — deleted rows are filtered from reads.
export const pitMessages = pgTable('pit_messages', {
  id:        serial('id').primaryKey(),
  userId:    text('user_id').notNull(),                    // Clerk user ID (author)
  username:  text('username').notNull(),                   // display name at post time
  handle:    text('handle'),                               // author @handle at post time (→ /u/handle)
  avatarUrl: text('avatar_url'),                           // Clerk imageUrl at post time
  tier:      text('tier'),                                 // 'pro' | 'elite' at post time
  body:      text('body').notNull(),                       // sanitized message text
  deleted:   boolean('deleted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxCreated: index('idx_pit_messages_created').on(t.createdAt),
}));

// ── Community profiles (Phase 2) ─────────────────────────────────────────────
// One row per user — the social identity layer on top of Clerk. Auto-created with a default
// handle on first activity; users then customize. `handle` is the public URL key (/u/handle).
// `showWatchlist` is opt-in: a profile only exposes the user's watchlist when they enable it.
export const pitProfiles = pgTable('pit_profiles', {
  userId:        text('user_id').primaryKey(),          // Clerk user ID
  handle:        text('handle').notNull(),              // unique public @handle (lowercased)
  displayName:   text('display_name'),
  bio:           text('bio'),
  avatarUrl:     text('avatar_url'),                    // defaults to Clerk imageUrl
  xHandle:       text('x_handle'),                      // optional link to their X
  igHandle:      text('ig_handle'),                     // optional link to their Instagram
  showWatchlist: boolean('show_watchlist').notNull().default(false),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqHandle: uniqueIndex('uq_pit_profiles_handle').on(t.handle),
}));

// Reactions on chat messages (👍❤️🔥 …). One row per (message, user, emoji). Any signed-in user.
export const pitMessageReactions = pgTable('pit_message_reactions', {
  messageId: integer('message_id').notNull(),
  userId:    text('user_id').notNull(),
  emoji:     text('emoji').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk:     primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
  idxMsg: index('idx_pit_reactions_msg').on(t.messageId),
}));

// ── Notifications (Phase 4) — one row per event delivered to a recipient ──
// type: 'follow' | 'like' | 'comment'. Actor identity snapshotted for rendering without a join.
export const pitNotifications = pgTable('pit_notifications', {
  id:          serial('id').primaryKey(),
  userId:      text('user_id').notNull(),          // recipient
  actorUserId: text('actor_user_id'),
  actorName:   text('actor_name'),
  actorHandle: text('actor_handle'),
  actorAvatar: text('actor_avatar'),
  type:        text('type').notNull(),
  postId:      integer('post_id'),
  excerpt:     text('excerpt'),
  read:        boolean('read').notNull().default(false),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxUser: index('idx_pit_notifs_user').on(t.userId, t.createdAt),
}));

// ── Follows (Phase 3) — directed edges: follower → following (both Clerk user IDs) ──
export const pitFollows = pgTable('pit_follows', {
  followerId:  text('follower_id').notNull(),
  followingId: text('following_id').notNull(),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk:          primaryKey({ columns: [t.followerId, t.followingId] }),
  idxFollowing: index('idx_pit_follows_following').on(t.followingId),
}));

// ── Feed posts (Phase 3) — persistent "thoughts", Facebook/StockTwits style ──
// Author identity is snapshotted (like chat) so the feed renders even if a profile changes.
// likeCount is denormalized off pit_post_likes for cheap sorting/display.
export const pitPosts = pgTable('pit_posts', {
  id:           serial('id').primaryKey(),
  userId:       text('user_id').notNull(),
  handle:       text('handle'),
  username:     text('username').notNull(),
  avatarUrl:    text('avatar_url'),
  body:         text('body').notNull(),
  imageUrl:     text('image_url'),                                  // optional attached picture
  likeCount:    integer('like_count').notNull().default(0),
  commentCount: integer('comment_count').notNull().default(0),
  deleted:      boolean('deleted').notNull().default(false),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxCreated: index('idx_pit_posts_created').on(t.createdAt),
  idxUser:    index('idx_pit_posts_user').on(t.userId),
}));

// One reaction per user per post (Facebook-style — pk on post+user). `emoji` is the chosen
// reaction (defaults to 👍); pit_posts.like_count = total reactions on the post.
export const pitPostLikes = pgTable('pit_post_likes', {
  postId:    integer('post_id').notNull(),
  userId:    text('user_id').notNull(),
  emoji:     text('emoji').notNull().default('👍'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.postId, t.userId] }),
}));

// Comments on feed posts. Author identity resolved live from profiles at read time (snapshot kept
// as fallback). commentCount on pit_posts is denormalized off this table.
export const pitPostComments = pgTable('pit_post_comments', {
  id:        serial('id').primaryKey(),
  postId:    integer('post_id').notNull(),
  userId:    text('user_id').notNull(),
  handle:    text('handle'),
  username:  text('username').notNull(),
  avatarUrl: text('avatar_url'),
  body:      text('body').notNull(),
  deleted:   boolean('deleted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxPost: index('idx_pit_comments_post').on(t.postId),
}));

// Message reports (any signed-in user can flag; admin reviews). Kept separate from
// messages so a message can accrue multiple reports without mutating the row.
export const pitReports = pgTable('pit_reports', {
  id:             serial('id').primaryKey(),
  messageId:      integer('message_id').notNull(),
  reporterUserId: text('reporter_user_id').notNull(),
  reason:         text('reason'),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxMessage: index('idx_pit_reports_message').on(t.messageId),
}));

// Per-manager, per-quarter filing summary — powers the list + latest-quarter lookups without
// scanning holdings. total_value = 13F portfolio value (long US positions only), whole dollars.
export const fundFilings = pgTable('fund_filings', {
  cik:           text('cik').notNull(),
  quarter:       date('quarter', { mode: 'string' }).notNull(),
  filedDate:     date('filed_date', { mode: 'string' }),
  accession:     text('accession'),
  totalValue:    doublePrecision('total_value'),
  holdingsCount: integer('holdings_count'),
  insertedAt:    timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.cik, t.quarter] }),
}));

// ── Stock Screener universe ──────────────────────────────────────────────────
// One denormalized row per screenable US ticker. The screener queries THIS table only
// (never external APIs per keystroke). Populated by lib/screener-data.js rebuild():
//  - proprietary signal cols (insider/congress/13F/consensus/8-K/news) from our own tables
//  - price/volume/technical cols computed from ticker_daily_candles (our warmed set)
//  - short interest / float from short_interest + ticker_float
//  - descriptive/valuation/growth/quality cols stay NULL until a bulk provider is ingested
//    (Finviz-foundation filters render "coming soon" while null).
export const screenerStocks = pgTable('screener_stocks', {
  ticker:        text('ticker').primaryKey(),
  company:       text('company'),
  // descriptive (mostly provider-fed — null until a feed lands)
  exchange:      text('exchange'),
  sector:        text('sector'),
  industry:      text('industry'),
  country:       text('country'),
  assetType:     text('asset_type'),          // 'stock' | 'etf'
  marketCap:     doublePrecision('market_cap'),
  ipoDate:       date('ipo_date', { mode: 'string' }),
  // price / volume (from candles — our warmed set)
  price:         doublePrecision('price'),
  changePct:     doublePrecision('change_pct'),
  volume:        doublePrecision('volume'),
  avgVol:        doublePrecision('avg_vol'),
  relVol:        doublePrecision('rel_vol'),
  floatShares:   doublePrecision('float_shares'),
  sharesOut:     doublePrecision('shares_out'),
  shortFloat:    doublePrecision('short_float'),
  daysToCover:   doublePrecision('days_to_cover'),
  dividendYield: doublePrecision('dividend_yield'),
  beta:          doublePrecision('beta'),
  // technical (computed from candles)
  rsi14:         doublePrecision('rsi14'),
  sma20:         doublePrecision('sma20'),
  sma50:         doublePrecision('sma50'),
  sma200:        doublePrecision('sma200'),
  hi52:          doublePrecision('hi52'),
  lo52:          doublePrecision('lo52'),
  atr14:         doublePrecision('atr14'),
  perf1w:        doublePrecision('perf_1w'),
  perf1m:        doublePrecision('perf_1m'),
  perf3m:        doublePrecision('perf_3m'),
  perf6m:        doublePrecision('perf_6m'),
  perfYtd:       doublePrecision('perf_ytd'),
  perf1y:        doublePrecision('perf_1y'),
  perf3y:        doublePrecision('perf_3y'),
  perf5y:        doublePrecision('perf_5y'),
  // valuation / growth / quality / ownership (provider — null until a feed lands)
  pe:            doublePrecision('pe'),
  forwardPe:     doublePrecision('forward_pe'),
  peg:           doublePrecision('peg'),
  ps:            doublePrecision('ps'),
  pb:            doublePrecision('pb'),
  evEbitda:      doublePrecision('ev_ebitda'),
  epsGrowthTtm:  doublePrecision('eps_growth_ttm'),
  revGrowthTtm:  doublePrecision('rev_growth_ttm'),
  roe:           doublePrecision('roe'),
  grossMargin:   doublePrecision('gross_margin'),
  netMargin:     doublePrecision('net_margin'),
  debtEquity:    doublePrecision('debt_equity'),
  insiderOwnPct: doublePrecision('insider_own_pct'),
  instOwnPct:    doublePrecision('inst_own_pct'),
  // additional Polygon-computed fundamentals (self-created via ALTER)
  evSales:       doublePrecision('ev_sales'),
  pCash:         doublePrecision('p_cash'),
  roa:           doublePrecision('roa'),
  operMargin:    doublePrecision('oper_margin'),
  currentRatio:  doublePrecision('current_ratio'),
  quickRatio:    doublePrecision('quick_ratio'),
  ltDebtEquity:  doublePrecision('lt_debt_equity'),
  epsGrowthQoq:  doublePrecision('eps_growth_qoq'),
  salesGrowthQoq:doublePrecision('sales_growth_qoq'),
  epsGrowth3y:   doublePrecision('eps_growth_3y'),
  salesGrowth3y: doublePrecision('sales_growth_3y'),
  epsGrowth5y:   doublePrecision('eps_growth_5y'),
  salesGrowth5y: doublePrecision('sales_growth_5y'),
  epsGrowthThisYr: doublePrecision('eps_growth_this_yr'),
  roic:          doublePrecision('roic'),
  payoutRatio:   doublePrecision('payout_ratio'),
  // Polygon-computed quote/technical extras (self-created via ALTER)
  changeFromOpen:doublePrecision('change_from_open'),
  gap:           doublePrecision('gap'),
  volatility:    doublePrecision('volatility'),
  high20d:       doublePrecision('high20d'),
  high50d:       doublePrecision('high50d'),
  allTimeHigh:   doublePrecision('all_time_high'),
  // ── proprietary Catalyst Pit signals (AVAILABLE NOW) ──
  insiderNet90d:    doublePrecision('insider_net_90d'),   // sum(buys)-sum(sells) $ over 90d
  insiderBuyers90d: integer('insider_buyers_90d'),        // distinct execs buying, 90d
  insiderBuy90d:    boolean('insider_buy_90d').default(false),
  insiderSell90d:   boolean('insider_sell_90d').default(false),
  congressNet90d:   doublePrecision('congress_net_90d'),
  congressBuy90d:   boolean('congress_buy_90d').default(false),
  fundNetQoq:       integer('fund_net_qoq'),              // 13F accumulating - reducing funds
  consensusScore:   integer('consensus_score'),           // Pit Consensus (bull) score
  hasMaterial8k:    boolean('has_material_8k').default(false),
  newsRecent:       boolean('news_recent').default(false),
  newsCategory:     text('news_category'),                 // most-recent 8-K catalyst category
  breakingToday:    boolean('breaking_today').default(false),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxSector:    index('idx_screener_sector').on(t.sector),
  idxMcap:      index('idx_screener_mcap').on(t.marketCap),
  idxConsensus: index('idx_screener_consensus').on(t.consensusScore),
  idxInsiderBuy: index('idx_screener_insider_buy').on(t.insiderBuy90d),
  idxPrice:     index('idx_screener_price').on(t.price),
}));

// Persistent per-ticker reference data from Polygon ticker-details (market cap / sector / exchange /
// asset type / shares). Separate table so it SURVIVES the screener_stocks clean-rebuild; the rebuild
// reads it to fill the descriptive columns. Populated by /api/cron/screener-meta (bounded, accumulates).
export const screenerMeta = pgTable('screener_meta', {
  ticker:    text('ticker').primaryKey(),
  marketCap: doublePrecision('market_cap'),
  sector:    text('sector'),
  industry:  text('industry'),
  exchange:  text('exchange'),
  assetType: text('asset_type'),
  country:   text('country'),
  sharesOut: doublePrecision('shares_out'),
  annualDividend: doublePrecision('annual_dividend'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Persistent fundamentals from Polygon Financials (SEC statements). Stores price-INDEPENDENT computed
// values + raw inputs (epsTtm/revenueTtm/equity/debt/cash/ebitda); the rebuild derives price-dependent
// ratios (P/E, P/S, P/B, EV/*) nightly with fresh price. Separate table → survives the clean-rebuild.
export const screenerFundamentals = pgTable('screener_fundamentals', {
  ticker:        text('ticker').primaryKey(),
  epsTtm:        doublePrecision('eps_ttm'),
  revenueTtm:    doublePrecision('revenue_ttm'),
  equity:        doublePrecision('equity'),
  totalDebt:     doublePrecision('total_debt'),
  cash:          doublePrecision('cash'),
  ebitda:        doublePrecision('ebitda'),
  grossMargin:   doublePrecision('gross_margin'),
  operMargin:    doublePrecision('oper_margin'),
  netMargin:     doublePrecision('net_margin'),
  roe:           doublePrecision('roe'),
  roa:           doublePrecision('roa'),
  currentRatio:  doublePrecision('current_ratio'),
  quickRatio:    doublePrecision('quick_ratio'),
  debtEquity:    doublePrecision('debt_equity'),
  ltDebtEquity:  doublePrecision('lt_debt_equity'),
  epsGrowthTtm:  doublePrecision('eps_growth_ttm'),
  revGrowthTtm:  doublePrecision('rev_growth_ttm'),
  epsGrowthQoq:  doublePrecision('eps_growth_qoq'),
  salesGrowthQoq:doublePrecision('sales_growth_qoq'),
  epsGrowth3y:   doublePrecision('eps_growth_3y'),
  salesGrowth3y: doublePrecision('sales_growth_3y'),
  epsGrowth5y:   doublePrecision('eps_growth_5y'),
  salesGrowth5y: doublePrecision('sales_growth_5y'),
  epsGrowthThisYr: doublePrecision('eps_growth_this_yr'),
  roic:          doublePrecision('roic'),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Saved screeners (logged-in users). filters/columns are JSON blobs (the filter set + view + columns).
export const screenerSaved = pgTable('screener_saved', {
  id:        serial('id').primaryKey(),
  userId:    text('user_id').notNull(),
  name:      text('name').notNull(),
  filters:   text('filters'),                 // JSON string of active filters
  sortBy:    text('sort_by'),
  sortDir:   text('sort_dir'),
  view:      text('view'),
  columns:   text('columns'),                 // JSON string of custom column keys
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxUser: index('idx_screener_saved_user').on(t.userId),
}));
