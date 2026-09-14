// Official primary-source feed registry and normalisation. PURE: fetching and parsing only, no DB
// and no Redis, so it can be unit-run and so the ingest caller owns all persistence.
//
// Rules that are not negotiable here:
//   - Official first-party feeds only. No scraping, no aggregators, no paid vendors.
//   - original_url is always the source's own link.
//   - summary is null when the feed gives none. Nothing is written that the source did not say.
//   - Macro sources never carry a ticker. See TICKERABLE below.

import { createHash } from 'node:crypto';
import { canonicalHeadline, isDisplayable, entityToken, factSignature, scoreImportance, statedTickersIn } from './news-normalize.mjs';
import { isNonEnglish } from './language.mjs';
import { normHash } from './event-cluster.mjs';
import { composeHeadline } from './headline-compose.mjs';
import { TRUSTED_MIN_IMPORTANCE } from './trusted-sources.mjs';

export const UA = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };

// Sources whose items may carry a ticker at all. Fed, BLS, BEA, Treasury and EIA describe the
// economy, not a company: attaching a symbol to "CPI rose 0.2%" would be an invention. FDA, FTC and
// DOJ name companies in prose and go through the existing conservative resolver, which returns
// nothing unless a name maps to exactly one registrant.
export const TICKERABLE = new Set(['FDA', 'FTC', 'DOJ']);

// Whether a source may carry a ticker at all, derived from the registry rather than a second list
// that could drift out of step with it. A macro source stays ticker-free no matter what: attaching
// a symbol to "CPI rose 0.2%" would be an invention.
let _tickerableSources = null;
export function isTickerableSource(source) {
  if (!_tickerableSources) {
    _tickerableSources = new Set(FEEDS.filter((f) => f.tickerable).map((f) => f.source));
    for (const s of TICKERABLE) _tickerableSources.add(s);
  }
  return _tickerableSources.has(source);
}

// ── source registry ──────────────────────────────────────────────────────────
// Every source, whatever its wire format, is ONE declarative entry. Adding a source is an entry
// here — never a code change anywhere downstream, because every adapter emits the same item shape.
//
//   key         unique feed id, also the feed_state primary key
//   source      registry code stored in primary_events.source ('FED', 'REUTERS', …)
//   sourceName  display name ('Federal Reserve') — preserved for traceability
//   type        source_type stored on the event
//   adapter     'rss' | 'atom' | 'json' | 'api'   (see news-adapters.mjs)
//   url         endpoint
//   everySec    poll cadence; conditional GET makes a routine poll a 304 with no body
//   category    fixed category, or omitted to derive from `source`
//   rewrite     true  → eligible for a Catalyst Pit original headline
//               false → the source's own headline is always kept verbatim
//   tickerable  true  → may carry a ticker (conservatively resolved, or stated by the source)
//   map         JSON field paths, for the json/api adapters only
//   headers     extra request headers, e.g. an API key read from process.env
//   strip       regexes removing the channel's own watermark from the headline ("|FJ",
//               "(@WalterBloomberg)"). Display and dedupe use the cleaned line; source_headline
//               and raw keep the original exactly as published.
//   trusted     operator-designated high-signal breaking news. The ONLY flag here that overrides a
//               content-based decision: importance floor, no noise classification, top rewrite
//               priority, never parked with the publisher's wording. See trusted-sources.mjs.
//               Capture, dedupe, provenance and ticker confidence are untouched by it.
//
// SEC is deliberately ABSENT from this registry. SEC events are projected from eightk_filings by
// the existing pipeline and never pass through fetching, rewriting or enrichment.
// ── polling tiers ────────────────────────────────────────────────────────────
// A breaking wire and a working-paper archive must not consume the same polling budget. Every feed
// declares a tier; the number is its cadence in seconds.
//
//   FLASH  15s  breaking wires and Fed policy — where seconds decide whether we were first
//   FAST   60s  market headlines and high-value press releases
//   NORMAL  5m  general financial news and corporate PR
//   SLOW   30m  analysis, transcripts, research
//   GLACIAL 6h  working papers, statistical archives, non-urgent publications
export const TIER = { FLASH: 15, FAST: 60, NORMAL: 300, SLOW: 1800, GLACIAL: 21600 };

const GNW = 'https://www.globenewswire.com/RssFeed';

const defaults = { adapter: 'rss', rewrite: true, tickerable: false, kind: 'external' };
const feed = (f) => ({ ...defaults, ...f });

export const FEEDS = [
  // ══ MACRO / GOVERNMENT / REGULATORY ═══════════════════════════════════════
  // Verified reachable and parsing during integration. Approved for rewriting into the unified
  // Catalyst Pit feed; original source, headline, URL, timestamp and raw payload are always kept.
  feed({ key: 'fed_press', source: 'FED', sourceName: 'Federal Reserve', type: 'release', everySec: TIER.FLASH,
    url: 'https://www.federalreserve.gov/feeds/press_all.xml' }),
  feed({ key: 'fed_monetary', source: 'FED', sourceName: 'Federal Reserve', type: 'statement', everySec: TIER.FLASH,
    url: 'https://www.federalreserve.gov/feeds/press_monetary.xml' }),
  feed({ key: 'fed_speeches', source: 'FED', sourceName: 'Federal Reserve', type: 'speech', everySec: TIER.SLOW,
    url: 'https://www.federalreserve.gov/feeds/speeches.xml' }),
  feed({ key: 'fed_testimony', source: 'FED', sourceName: 'Federal Reserve', type: 'testimony', everySec: TIER.SLOW,
    url: 'https://www.federalreserve.gov/feeds/testimony.xml' }),
  // Statistical release notices. Low urgency and largely duplicative of one another, which is
  // exactly what dedupe is for; polled rarely so they cost almost nothing.
  feed({ key: 'fed_g19', source: 'FED', sourceName: 'Federal Reserve', type: 'data', everySec: TIER.GLACIAL,
    url: 'https://www.federalreserve.gov/feeds/g19.xml' }),
  feed({ key: 'fed_g20', source: 'FED', sourceName: 'Federal Reserve', type: 'data', everySec: TIER.GLACIAL,
    url: 'https://www.federalreserve.gov/feeds/g20.xml' }),
  feed({ key: 'fed_prates', source: 'FED', sourceName: 'Federal Reserve', type: 'data', everySec: TIER.GLACIAL,
    url: 'https://www.federalreserve.gov/feeds/prates.xml' }),
  feed({ key: 'fed_working_papers', source: 'FED', sourceName: 'Federal Reserve', type: 'research', everySec: TIER.GLACIAL,
    url: 'https://www.federalreserve.gov/feeds/working_papers.xml' }),

  feed({ key: 'ecb_press', source: 'ECB', sourceName: 'European Central Bank', type: 'release', everySec: TIER.FAST,
    url: 'https://www.ecb.europa.eu/rss/press.html' }),

  feed({ key: 'cftc_enforcement', source: 'CFTC', sourceName: 'CFTC', type: 'enforcement', everySec: TIER.NORMAL,
    url: 'https://www.cftc.gov/RSS/RSSENF/rssenf.xml', tickerable: true }),
  feed({ key: 'cftc_press', source: 'CFTC', sourceName: 'CFTC', type: 'release', everySec: TIER.NORMAL,
    url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', tickerable: true }),
  feed({ key: 'cftc_speeches', source: 'CFTC', sourceName: 'CFTC', type: 'speech', everySec: TIER.SLOW,
    url: 'https://www.cftc.gov/RSS/RSSST/rssst.xml' }),

  feed({ key: 'fda_press', source: 'FDA', sourceName: 'FDA', type: 'release', everySec: TIER.FAST,
    url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml', tickerable: true }),
  feed({ key: 'fda_drugs', source: 'FDA', sourceName: 'FDA', type: 'approval', everySec: TIER.FAST,
    url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/drugs/rss.xml', tickerable: true }),

  feed({ key: 'ftc_press', source: 'FTC', sourceName: 'FTC', type: 'enforcement', everySec: TIER.NORMAL,
    url: 'https://www.ftc.gov/feeds/press-release.xml', tickerable: true }),
  feed({ key: 'ftc_competition', source: 'FTC', sourceName: 'FTC', type: 'enforcement', everySec: TIER.NORMAL,
    url: 'https://www.ftc.gov/feeds/press-release-competition.xml', tickerable: true }),
  feed({ key: 'doj_press', source: 'DOJ', sourceName: 'Justice Department', type: 'enforcement', everySec: TIER.NORMAL,
    url: 'https://www.justice.gov/news/rss?type=press_release', tickerable: true }),

  feed({ key: 'eia_press', source: 'EIA', sourceName: 'EIA', type: 'release', everySec: TIER.NORMAL,
    url: 'https://www.eia.gov/rss/press_rss.xml' }),
  feed({ key: 'eia_today', source: 'EIA', sourceName: 'EIA', type: 'analysis', everySec: TIER.NORMAL,
    url: 'https://www.eia.gov/rss/todayinenergy.xml' }),
  feed({ key: 'eia_whatsnew', source: 'EIA', sourceName: 'EIA', type: 'release', everySec: TIER.NORMAL,
    url: 'https://www.eia.gov/about/new/WNtest3.php' }),
  feed({ key: 'eia_gas_diesel', source: 'EIA', sourceName: 'EIA', type: 'data', everySec: TIER.SLOW,
    url: 'https://www.eia.gov/petroleum/gasdiesel/includes/gas_diesel_rss.xml' }),
  feed({ key: 'eia_presentations', source: 'EIA', sourceName: 'EIA', type: 'analysis', everySec: TIER.GLACIAL,
    url: 'https://www.eia.gov/rss/presentations.xml' }),

  // ══ BREAKING WIRES ════════════════════════════════════════════════════════
  // FinancialJuice publishes a public, unauthenticated RSS endpoint that its own homepage links to.
  // No login, token, paywall or CAPTCHA is involved. It sends no ETag/Last-Modified, so every poll
  // transfers the body — and it will not take FLASH: polled at 15s it answered 429 to six of eight
  // requests, where its own Telegram channel below answered 200 to eight of eight. So this stays at
  // FAST as the durable copy of record, and the Telegram channel carries the speed.
  // Every line is signed "FinancialJuice: "; that prefix is the channel, not the event.
  feed({ key: 'financialjuice', source: 'FINANCIALJUICE', sourceName: 'FinancialJuice', type: 'wire',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    strip: [/^\s*FinancialJuice\s*:\s*/i, /\s*\|\s*FJ\s*$/i],
    url: 'https://www.financialjuice.com/feed.ashx' }),
  // The same operator's own public Telegram channel, carrying the same lines. Registered under the
  // SAME source code and with the same `strip`, so once both watermarks are off ("FinancialJuice: "
  // on the RSS, "|FJ" here) the two arrivals of one headline are byte-identical and collapse on the
  // norm_hash layer into one canonical event — whichever got there first. It exists purely to close
  // the 60s gap the RSS cannot: 15s here, and the RSS behind it so nothing is lost if t.me is down.
  feed({ key: 'telegram_financialjuice', source: 'FINANCIALJUICE', sourceName: 'FinancialJuice', type: 'wire',
    adapter: 'telegram', everySec: TIER.FLASH, category: 'MARKETS', tickerable: true,
    strip: [/^\s*FinancialJuice\s*:\s*/i, /\s*\|\s*FJ\s*$/i],
    url: 'https://t.me/s/financialjuice' }),
  // Telegram's own public channel preview page. Public content, no authentication.
  // Signs every line "(@BreakingMarketNews)". Left in, that watermark changed the normalised text
  // enough that its copy of a headline would not collapse against FinancialJuice's copy of the same
  // headline — three canonical rows for one wire flash, on the tape, in production.
  feed({ key: 'telegram_bmn', source: 'BREAKINGMARKETNEWS', sourceName: 'Breaking Market News', type: 'wire',
    adapter: 'telegram', everySec: TIER.FLASH, category: 'MARKETS', tickerable: true,
    strip: [/\s*\(\s*@?breaking\s*market\s*news\s*\)/gi],
    url: 'https://t.me/s/breakingmarketnews' }),
  // Walter Bloomberg's own public Telegram channel — the operator's first-party distribution of the
  // same headlines they post as @DeItaone on X, which has no feed of any kind we may read.
  //
  // Identified by measurement, not by name. Against a captured window of @DeItaone's posts, this
  // channel carried the same lines a MEDIAN OF 1 SECOND later (13 matched pairs, worst 80s), while
  // the similarly-named t.me/walter_bloomberg ran 433s behind with decoration added — a relay, not
  // the source. Registering the wrong one would have cost seven minutes on every headline.
  // Each line is signed "(@WalterBloomberg)"; that is the channel's watermark, not the event.
  //
  // `trusted` is an operator judgement about the SOURCE, and it is the only thing in this registry
  // that overrides a content-based decision. See trusted-sources.mjs for exactly what it changes —
  // an importance floor, no noise classification, queue priority and a larger rewrite budget. It
  // changes nothing about capture, dedupe, provenance or ticker confidence.
  feed({ key: 'telegram_walterbloomberg', source: 'WALTERBLOOMBERG', sourceName: 'Walter Bloomberg', type: 'wire',
    adapter: 'telegram', everySec: TIER.FLASH, category: 'MARKETS', tickerable: true, trusted: true,
    // The leading "*" is the terminal convention for a flash headline, not part of the sentence;
    // left on, it survives into the display headline and into every text comparison dedupe makes.
    strip: [/\s*\(\s*@?walter\s*bloomberg\s*\)/gi, /^\s*\*+\s*/],
    url: 'https://t.me/s/WalterBloomberg' }),

  // ══ FINANCIAL / MARKET NEWS ═══════════════════════════════════════════════
  feed({ key: 'sa_market_currents', source: 'SEEKINGALPHA', sourceName: 'Seeking Alpha', type: 'article',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true, url: 'https://seekingalpha.com/market_currents.xml' }),
  feed({ key: 'sa_main', source: 'SEEKINGALPHA', sourceName: 'Seeking Alpha', type: 'article',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true, url: 'https://seekingalpha.com/feed.xml' }),
  feed({ key: 'sa_transcripts', source: 'SEEKINGALPHA', sourceName: 'Seeking Alpha', type: 'transcript',
    everySec: TIER.SLOW, category: 'MARKETS', tickerable: true, url: 'https://seekingalpha.com/sector/transcripts.xml' }),
  feed({ key: 'sa_popular', source: 'SEEKINGALPHA', sourceName: 'Seeking Alpha', type: 'analysis',
    everySec: TIER.SLOW, category: 'MARKETS', tickerable: true, url: 'https://seekingalpha.com/listing/most-popular-articles.xml' }),
  feed({ key: 'sa_editors', source: 'SEEKINGALPHA', sourceName: 'Seeking Alpha', type: 'analysis',
    everySec: TIER.SLOW, category: 'MARKETS', tickerable: true, url: 'https://seekingalpha.com/tag/editors-picks.xml' }),
  feed({ key: 'sa_breakfast', source: 'SEEKINGALPHA', sourceName: 'Seeking Alpha', type: 'analysis',
    everySec: TIER.SLOW, category: 'MARKETS', tickerable: true, url: 'https://seekingalpha.com/tag/wall-st-breakfast.xml' }),
  feed({ key: 'sa_ipo', source: 'SEEKINGALPHA', sourceName: 'Seeking Alpha', type: 'analysis',
    everySec: TIER.SLOW, category: 'MARKETS', tickerable: true, url: 'https://seekingalpha.com/tag/ipo-analysis.xml' }),

  feed({ key: 'investing_news', source: 'INVESTING', sourceName: 'Investing.com', type: 'article',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true, url: 'https://www.investing.com/rss/news.rss' }),
  feed({ key: 'investing_stock', source: 'INVESTING', sourceName: 'Investing.com', type: 'article',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true, url: 'https://www.investing.com/rss/stock.rss' }),
  feed({ key: 'investing_overview', source: 'INVESTING', sourceName: 'Investing.com', type: 'analysis',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true, url: 'https://www.investing.com/rss/market_overview.rss' }),
  feed({ key: 'investing_bonds', source: 'INVESTING', sourceName: 'Investing.com', type: 'analysis',
    everySec: TIER.NORMAL, category: 'MARKETS', url: 'https://www.investing.com/rss/bonds.rss' }),
  feed({ key: 'investing_121899', source: 'INVESTING', sourceName: 'Investing.com', type: 'analysis',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true, url: 'https://www.investing.com/rss/121899.rss' }),
  feed({ key: 'investing_286', source: 'INVESTING', sourceName: 'Investing.com', type: 'analysis',
    everySec: TIER.NORMAL, category: 'MARKETS', url: 'https://www.investing.com/rss/286.rss' }),

  feed({ key: 'marketwatch_top', source: 'MARKETWATCH', sourceName: 'MarketWatch', type: 'article',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' }),
  feed({ key: 'cnbc_finance', source: 'CNBC', sourceName: 'CNBC', type: 'article',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html' }),
  feed({ key: 'yahoo_finance', source: 'YAHOO', sourceName: 'Yahoo Finance', type: 'article',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: 'https://finance.yahoo.com/news/rssindex' }),
  feed({ key: 'bloomberg_markets', source: 'BLOOMBERG', sourceName: 'Bloomberg', type: 'article',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: 'https://www.bloomberg.com/feeds/markets/news.rss' }),
  feed({ key: 'ft_markets', source: 'FT', sourceName: 'Financial Times', type: 'article',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: 'https://www.ft.com/markets?format=rss' }),
  feed({ key: 'economist_finance', source: 'ECONOMIST', sourceName: 'The Economist', type: 'analysis',
    everySec: TIER.SLOW, category: 'MARKETS',
    url: 'https://www.economist.com/finance-and-economics/rss.xml' }),
  feed({ key: 'axios', source: 'AXIOS', sourceName: 'Axios', type: 'article',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true, url: 'https://api.axios.com/feed/' }),
  feed({ key: 'techcrunch', source: 'TECHCRUNCH', sourceName: 'TechCrunch', type: 'article',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true, url: 'https://techcrunch.com/feed/' }),

  // ══ PRESS RELEASE WIRES ═══════════════════════════════════════════════════
  // Overlap between the master feed and the subject feeds is intentional: the master carries only
  // 20 items and can roll over in under a minute during the pre-open PR rush, so the subject feeds
  // are depth, not duplication. Dedupe collapses whatever arrives twice.
  feed({ key: 'gnw_public', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: `${GNW}/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies` }),
  feed({ key: 'gnw_earnings', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: `${GNW}/subjectcode/13-Earnings%20Releases%20and%20Operating%20Results/feedTitle/x` }),
  feed({ key: 'gnw_ma', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: `${GNW}/subjectcode/27-Mergers%20and%20Acquisitions/feedTitle/x` }),
  feed({ key: 'gnw_clinical', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.FAST, category: 'PHARMA', tickerable: true,
    url: `${GNW}/subjectcode/90-Clinical%20Study/feedTitle/x` }),
  // GlobeNewswire publishes NO Biotechnology or Pharmaceuticals subject code — Health (20) and
  // Clinical Study (90, already registered above) are the biotech-bearing ones, so Health is what
  // gets added rather than inventing a subject code that does not exist.
  feed({ key: 'gnw_health', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.NORMAL, category: 'PHARMA', tickerable: true,
    url: `${GNW}/subjectcode/20-Health/feedTitle/x` }),
  feed({ key: 'gnw_dividends', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: `${GNW}/subjectcode/12-Dividend%20Reports%20and%20Estimates/feedTitle/x` }),
  feed({ key: 'gnw_bankruptcy', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: `${GNW}/subjectcode/5-Bankruptcy/feedTitle/x` }),
  feed({ key: 'gnw_ipo', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: `${GNW}/subjectcode/21-Initial%20Public%20Offerings/feedTitle/x` }),
  feed({ key: 'gnw_management', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: `${GNW}/subjectcode/86-Management%20Changes/feedTitle/x` }),
  feed({ key: 'gnw_financing', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: `${GNW}/subjectcode/17-Financing%20Agreements/feedTitle/x` }),
  feed({ key: 'gnw_own_shares', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: `${GNW}/subjectcode/58-Changes%20In%20Company%2027s%20Own%20Shares/feedTitle/x` }),
  feed({ key: 'gnw_corporate_action', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire', type: 'press_release',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: `${GNW}/subjectcode/61-Corporate%20Action/feedTitle/x` }),

  feed({ key: 'prn_all', source: 'PRNEWSWIRE', sourceName: 'PR Newswire', type: 'press_release',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: 'https://www.prnewswire.com/rss/news-releases-list.rss' }),
  feed({ key: 'prn_financial', source: 'PRNEWSWIRE', sourceName: 'PR Newswire', type: 'press_release',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: 'https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss' }),
  feed({ key: 'prn_health', source: 'PRNEWSWIRE', sourceName: 'PR Newswire', type: 'press_release',
    everySec: TIER.NORMAL, category: 'PHARMA', tickerable: true,
    url: 'https://www.prnewswire.com/rss/health-latest-news/health-latest-news-list.rss' }),
  feed({ key: 'prn_energy', source: 'PRNEWSWIRE', sourceName: 'PR Newswire', type: 'press_release',
    everySec: TIER.NORMAL, category: 'ENERGY', tickerable: true,
    url: 'https://www.prnewswire.com/rss/energy-latest-news/energy-latest-news-list.rss' }),

  // Low signal-to-noise: the public token feed carries multilingual SEO releases alongside real
  // corporate news, so it is polled slowly and leans on importance scoring to stay out of the way.
  feed({ key: 'ein_general', source: 'EINPRESSWIRE', sourceName: 'EIN Presswire', type: 'press_release',
    everySec: TIER.SLOW, category: 'MARKETS', tickerable: true,
    url: 'https://www.einpresswire.com/rss/kYOgMzZ5jdDCEHmy' }),

  // ══ WALL STREET JOURNAL / DOW JONES ═══════════════════════════════════════
  // All five verified live (60/85/40/71/21 items, ETag present so polls are conditional).
  // NOTE: RSSMarketsMain is ALSO fetched by the legacy /api/refresh KV pipeline that feeds the old
  // News page. That is a separate consumer which was not modified; the canonical engine needs its
  // own copy, and dedupe collapses anything the two pipelines both surface.
  feed({ key: 'wsj_markets', source: 'WSJ', sourceName: 'Wall Street Journal', type: 'article',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain' }),
  feed({ key: 'wsj_business', source: 'WSJ', sourceName: 'Wall Street Journal', type: 'article',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: 'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness' }),
  feed({ key: 'wsj_tech', source: 'WSJ', sourceName: 'Wall Street Journal', type: 'article',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: 'https://feeds.content.dowjones.io/public/rss/RSSWSJD' }),
  feed({ key: 'wsj_world', source: 'WSJ', sourceName: 'Wall Street Journal', type: 'article',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: 'https://feeds.content.dowjones.io/public/rss/RSSWorldNews' }),
  feed({ key: 'wsj_politics', source: 'WSJ', sourceName: 'Wall Street Journal', type: 'article',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: 'https://feeds.content.dowjones.io/public/rss/socialpoliticsfeed' }),

  // ══ ZEROHEDGE ═════════════════════════════════════════════════════════════
  // Full feed rather than category feeds: 25 items with both ETag and Last-Modified, so one
  // conditional poll covers everything the category feeds would have split across many requests.
  feed({ key: 'zerohedge', source: 'ZEROHEDGE', sourceName: 'ZeroHedge', type: 'article',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: 'https://cms.zerohedge.com/fullrss2.xml' }),

  // ══ BLOOMBERG (additional desks) ══════════════════════════════════════════
  // bloomberg_markets already exists above and is NOT duplicated here: feeds.bloomberg.com/markets
  // and www.bloomberg.com/feeds/markets were verified to return byte-for-byte the same 20 items.
  feed({ key: 'bloomberg_economics', source: 'BLOOMBERG', sourceName: 'Bloomberg', type: 'article',
    everySec: TIER.FAST, category: 'MACRO', tickerable: true,
    url: 'https://feeds.bloomberg.com/economics/news.rss' }),
  feed({ key: 'bloomberg_business', source: 'BLOOMBERG', sourceName: 'Bloomberg', type: 'article',
    everySec: TIER.FAST, category: 'MARKETS', tickerable: true,
    url: 'https://feeds.bloomberg.com/business/news.rss' }),
  feed({ key: 'bloomberg_technology', source: 'BLOOMBERG', sourceName: 'Bloomberg', type: 'article',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: 'https://feeds.bloomberg.com/technology/news.rss' }),
  feed({ key: 'bloomberg_industries', source: 'BLOOMBERG', sourceName: 'Bloomberg', type: 'article',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: 'https://feeds.bloomberg.com/industries/news.rss' }),
  feed({ key: 'bloomberg_politics', source: 'BLOOMBERG', sourceName: 'Bloomberg', type: 'article',
    everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: 'https://feeds.bloomberg.com/politics/news.rss' }),

  // ══ BIOSPACE — biotech catalyst coverage ══════════════════════════════════
  // BioSpace sends NO ETag and NO Last-Modified, so every poll transfers the whole body. Cadence is
  // set accordingly: this is editorial coverage that follows the wires, and the company releases
  // themselves already arrive fast through GlobeNewswire and PR Newswire.
  feed({ key: 'biospace_fda', source: 'BIOSPACE', sourceName: 'BioSpace', type: 'article',
    everySec: TIER.NORMAL, category: 'PHARMA', tickerable: true,
    url: 'https://www.biospace.com/FDA.rss' }),
  feed({ key: 'biospace_drugdev', source: 'BIOSPACE', sourceName: 'BioSpace', type: 'article',
    everySec: TIER.NORMAL, category: 'PHARMA', tickerable: true,
    url: 'https://www.biospace.com/drug-development.rss' }),
  feed({ key: 'biospace_deals', source: 'BIOSPACE', sourceName: 'BioSpace', type: 'article',
    everySec: TIER.NORMAL, category: 'PHARMA', tickerable: true,
    url: 'https://www.biospace.com/deals.rss' }),
  feed({ key: 'biospace_policy', source: 'BIOSPACE', sourceName: 'BioSpace', type: 'article',
    everySec: TIER.SLOW, category: 'PHARMA', tickerable: true,
    url: 'https://www.biospace.com/policy.rss' }),
  feed({ key: 'biospace_all', source: 'BIOSPACE', sourceName: 'BioSpace', type: 'article',
    everySec: TIER.SLOW, category: 'PHARMA', tickerable: true,
    url: 'https://www.biospace.com/all-news.rss' }),

  // Biotech Newswire. The newsroom page is a 450KB HTML app, but it DECLARES two real RSS feeds in
  // its <head> — no HTML parsing is involved. The headline feed is taken rather than the full-text
  // one: both carry the same 15 items and the same summaries, and it is 25KB against 142KB.
  // It is the originating wire for the releases it carries, so it is polled at company-release speed
  // rather than at the editorial cadence BioSpace above gets. No ETag/Last-Modified, so every poll
  // transfers the body; at 25KB that is ~35MB/day and it answered 200 to six polls at 15s.
  feed({ key: 'biotechnewswire', source: 'BIOTECHNEWSWIRE', sourceName: 'Biotech Newswire', type: 'press_release',
    everySec: TIER.FAST, category: 'PHARMA', tickerable: true,
    url: 'https://www.biotechnewswire.ai/b3c-newswire-i.html?format=feed' }),

  // PR.com, Medical & Health category (103). A public RSS endpoint, handled by the generic adapter.
  // NORMAL rather than FAST on volume, not on capability: it answered 200 to six polls at 15s, but
  // the body is 72KB and most of what it carries is local-practice PR — "Welcoming Urologist, Dr.
  // Jude Appiah" — which lands at importance 0 and is already suppressed from the useful presets by
  // the existing low-impact-PR noise class. The biotech releases worth having are a minority of it.
  feed({ key: 'prcom_health', source: 'PRCOM', sourceName: 'PR.com', type: 'press_release',
    everySec: TIER.NORMAL, category: 'PHARMA', tickerable: true,
    url: 'https://www.pr.com/rss/news-by-category/103.xml' }),

  // ══ BARCHART ══════════════════════════════════════════════════════════════
  // BARCHART PUBLISHES NO USABLE RSS. Every feed-shaped path — /news/rss, /rss/news, /feeds/news
  // and the per-category variants — answers HTTP 202 with a ZERO-BYTE body from CloudFront, which
  // is a bot challenge rather than a 404: paths that certainly do not exist answer identically, and
  // a browser User-Agent gets the same 202 carrying a 2KB JS challenge instead of content. The
  // homepage declares no feed in its <head>, and robots.txt names no feed either — only sitemaps.
  //
  // The Google News sitemap IS public, is served from origin rather than through the challenge, and
  // carries the same newsroom: 101 stories with canonical URLs, titles and real ISO publication
  // dates. So that is what is registered, through the sitemap adapter.
  //
  // ONE feed, not the per-category set. Barchart exposes no category feeds to register, and this
  // single file already carries every desk — equities, options, futures, FX, energy, metals and
  // crypto all appear in it — so splitting it would mean registering the same URL repeatedly, which
  // is exactly the duplication to avoid. It gets no special standing: ordinary cadence, ordinary
  // dedupe, ordinary scoring.
  //
  // It sends Cache-Control s-maxage=300 but NO ETag and NO Last-Modified, so every poll transfers
  // the body (~72KB). NORMAL matches the 300s the origin itself declares as its freshness window;
  // polling faster would re-transfer an unchanged file.
  feed({ key: 'barchart_news', source: 'BARCHART', sourceName: 'Barchart', type: 'article',
    adapter: 'sitemap', everySec: TIER.NORMAL, category: 'MARKETS', tickerable: true,
    url: 'https://www.barchart.com/news/google-sitemap.xml' }),

  // ══ NEWS APIs (quota-limited) ═════════════════════════════════════════════
  // Paused automatically until the key exists, so a missing key is never a failing poll. Cadence is
  // sized to the free daily allowance, NOT to how fast we would like the data: at 100 calls/day a
  // 15-minute cadence is 96 calls, which fits with headroom for retries.
  feed({ key: 'marketaux', source: 'MARKETAUX', sourceName: 'Marketaux', type: 'article',
    adapter: 'json', everySec: 900, category: 'MARKETS', tickerable: true,
    requiresEnv: 'MARKETAUX_API_KEY', quotaPerDay: 100,
    url: 'https://api.marketaux.com/v1/news/all?filter_entities=true&language=en&limit=50',
    authQuery: { api_token: 'MARKETAUX_API_KEY' },
    map: { items: 'data', title: 'title', url: 'url', uid: 'uuid',
           publishedAt: 'published_at', summary: 'description', tickers: 'entities' } }),
  feed({ key: 'stockdata', source: 'STOCKDATA', sourceName: 'StockData.org', type: 'article',
    adapter: 'json', everySec: 900, category: 'MARKETS', tickerable: true,
    requiresEnv: 'STOCKDATA_API_KEY', quotaPerDay: 100,
    url: 'https://api.stockdata.org/v1/news/all?filter_entities=true&language=en&limit=50',
    authQuery: { api_token: 'STOCKDATA_API_KEY' },
    map: { items: 'data', title: 'title', url: 'url', uid: 'uuid',
           publishedAt: 'published_at', summary: 'description', tickers: 'entities' } }),
];

export const activeFeeds = () => FEEDS.filter((f) => !f.requiresEnv || process.env[f.requiresEnv]);

// Verified unreachable or unusable during the audit. Listed so they are visible as PENDING rather
// than silently absent, and so nobody substitutes an unofficial mirror to make them appear.
export const PENDING = [
  { source: 'BLS',      reason: 'bls_latest.rss returns a single rollup item, not a release list. Needs the Public Data API v2 plus the published release calendar.' },
  { source: 'BEA',      reason: 'apps.bea.gov/rss/rss.xml returns zero items and bea.gov/rss.xml is 404. The structured route is the BEA API, which needs a free key.' },
  { source: 'TREASURY', reason: 'home.treasury.gov and www.treasury.gov both time out from our hosts. No official feed confirmed reachable.' },
];

// ── minimal RSS/Atom reader ──────────────────────────────────────────────────
const strip = (s) => String(s || '')
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

const tagOf = (block, name) => {
  const m = block.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'));
  return m ? m[1] : '';
};
// Atom puts the URL in an attribute rather than the element body. EIA publishes RELATIVE paths
// ("/pressroom/releases/press592.php"), so a link is resolved against the feed's own origin, and
// official .gov links that arrive as http are upgraded: FDA's feed emits http and redirects anyway.
const linkOf = (block, base) => {
  let href = strip(tagOf(block, 'link'));
  if (!href || !/^https?:/i.test(href)) {
    const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
    if (m) href = m[1];
  }
  if (!href) return '';
  if (!/^https?:/i.test(href)) {
    try { href = new URL(href, base).toString(); } catch { return ''; }
  }
  return href.replace(/^http:\/\//i, 'https://');
};

// A date the source did not actually state is worse than no date: an unparseable value was landing
// as 1899-12-30, which sorts to the beginning of time and would bury a real release.
const SANE_FROM = Date.parse('2000-01-01');
const parseDate = (raw) => {
  if (!raw) return null;
  const t = Date.parse(strip(raw));
  if (!Number.isFinite(t)) return null;
  if (t < SANE_FROM || t > Date.now() + 2 * 86400000) return null;
  return new Date(t).toISOString();
};

export function parseFeed(xml, base) {
  const blocks = String(xml || '').match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = strip(tagOf(b, 'title'));
    const url = linkOf(b, base);
    if (!title || !url) continue;                       // an item we cannot link to is not usable
    const publishedAt = parseDate(tagOf(b, 'pubDate'))
      || parseDate(tagOf(b, 'published')) || parseDate(tagOf(b, 'updated')) || parseDate(tagOf(b, 'date'));
    const body = strip(tagOf(b, 'description') || tagOf(b, 'summary') || tagOf(b, 'content'));
    out.push({
      title,
      url,
      // The feed's own identifier where it has one; the URL is a stable fallback.
      uid: strip(tagOf(b, 'guid')) || strip(tagOf(b, 'id')) || url,
      publishedAt,
      // Some feeds repeat the headline as the description. That is not a summary.
      summary: body && body !== title ? body.slice(0, 1200) : null,
    });
  }
  return out;
}

// A regulatory headline usually leads with the AGENCY, not the company: "FDA Approves First
// Therapy...", "FTC Takes Action Against...". Feeding that leading phrase to the name resolver is
// how you end up attributing a DOJ story about a person named Hardy to a registrant called Hardy
// Oil. So a candidate must look like a company: a run of capitalised words ending in a corporate
// form or a recognisable industry suffix. Anything else yields no candidate and no ticker.
const CORP_SUFFIX = String.raw`Inc|Incorporated|Corp|Corporation|Company|Co|LLC|L\.L\.C|Ltd|Limited`
  + String.raw`|PLC|plc|LP|L\.P|N\.V|NV|S\.A|AG|GmbH|AB|ASA|Holdings|Holding|Group`
  + String.raw`|Pharmaceuticals|Pharmaceutical|Pharma|Therapeutics|Biosciences|Biopharma|Bioscience`
  + String.raw`|Laboratories|Labs|Technologies|Technology|Systems|Industries|Networks|Solutions`
  + String.raw`|Motors|Airlines|Bancorp|Bancshares|Financial|Partners|Energy|Resources`;
const COMPANY_RE = new RegExp(
  String.raw`\b([A-Z][A-Za-z0-9&.'\-]*(?:\s+(?:[A-Z][A-Za-z0-9&.'\-]*|of|and|de|del|la|le)){0,5}[,]?\s+(?:${CORP_SUFFIX})\b\.?)`,
  'g');

// Headlines are title-cased, so an ordinary verb ("Sues", "Approves") is indistinguishable from a
// name token by shape alone and gets swept onto the front of the match. Peeling these off turns
// "Sues Amgen Inc." back into "Amgen Inc."; anything left that is still not a name simply fails the
// registrant lookup, which is the second gate.
const LEAD_NOISE = new RegExp(String.raw`^(?:The|A|An|And|Against|With|From|By|For|Of|To|Over|After`
  + String.raw`|FDA|FTC|DOJ|SEC|U\.S\.|US|Justice|Department|Attorney|General|Commission|Administration`
  + String.raw`|Sues?|Sued|Charges?|Charged|Announces?|Announced|Files?|Filed|Orders?|Ordered|Settles?|Settled`
  + String.raw`|Settling|Approves?|Approved|Authorizes?|Authorized|Fines?|Fined|Finalizes?|Finalized`
  + String.raw`|Obtains?|Secures?|Requires?|Blocks?|Challenges?|Alleges?|Accuses?|Indicts?|Sentences?|Sentenced`
  + String.raw`|Halts?|Warns?|Takes?|Issues?|Releases?|Grants?|Clears?|Denies?|Reaches?|Submits?|Extends?`
  + String.raw`|Endorses?|Urges?|Seeks?|Reviews?|Action|Statement|Complaint|Lawsuit|Today)\s+`, 'i');

export function companyPhrases(headline) {
  const out = [];
  for (const m of String(headline || '').matchAll(COMPANY_RE)) {
    let phrase = m[1].replace(/\s+/g, ' ').trim();
    let prev;
    do { prev = phrase; phrase = phrase.replace(LEAD_NOISE, ''); } while (phrase !== prev);
    if (phrase.length >= 6 && !out.includes(phrase)) out.push(phrase);
  }
  return out.slice(0, 2);
}

// ── importance, from the source and the words the source itself used ─────────
// Rule-based on purpose. A model would be a guess wearing a number.
const HIGH = [
  /\bFOMC\b/i, /federal open market committee/i, /\binterest rate\b/i, /monetary policy/i,
  /complete response letter/i, /\bapproval\b/i, /\bapproves?\b/i, /recall/i, /safety (alert|communication)/i,
  /\bsues?\b/i, /lawsuit/i, /\bantitrust\b/i, /merger challenge/i, /block(s|ed|ing)? the (proposed )?(merger|acquisition)/i,
  /consent (order|decree)/i, /\bindict/i, /\bfraud\b/i,
];
const NOTABLE = [/\bspeech\b/i, /\btestimony\b/i, /\bremarks\b/i, /proposed rule/i, /\bcomment\b/i, /\bguidance\b/i];

export function importanceOf({ source, type, title, summary }) {
  const hay = `${title} ${summary || ''}`;
  if (source === 'NASDAQ') return 2;                       // a trading halt is always actionable
  if (type === 'statement') return 2;                      // FOMC and monetary-policy statements
  if (HIGH.some((re) => re.test(hay))) return 2;
  if (type === 'approval' || type === 'enforcement') return 1;
  if (NOTABLE.some((re) => re.test(hay))) return 1;
  return 0;
}

export function categoryOf(source) {
  if (source === 'FED' || source === 'BLS' || source === 'BEA' || source === 'TREASURY') return 'MACRO';
  if (source === 'EIA') return 'ENERGY';
  if (source === 'FDA') return 'PHARMA';
  if (source === 'FTC' || source === 'DOJ') return 'REGULATORY';
  if (source === 'NASDAQ') return 'HALT';
  if (source === 'SEC') return 'FILING';
  return 'MARKETS';
}

// Identity for cross-feed dedupe. Normalised headline + calendar day: the same Fed statement on
// press_all and press_monetary has different guids but the same headline on the same day.
export function contentHash({ source, title, publishedAt }) {
  const day = publishedAt ? String(publishedAt).slice(0, 10) : '';
  const norm = String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(`${source}|${norm}|${day}`).digest('hex');
}

// One feed item → one normalized event. Tickers are attached later, and only by the caller, and only
// for TICKERABLE sources.
export function normalize(feed, item) {
  // Tickers the source stated: either as structured API fields, or printed in its own text as an
  // exchange-qualified symbol or a cashtag. Both are reading what the source said, not inferring.
  const tickers = feed.tickerable === false
    ? []
    : [...new Set([...(item.tickers || []), ...statedTickersIn(`${item.title} ${item.summary || ''}`)])].slice(0, 4);
  // Deterministic, instant, no AI: the event is displayable the moment it is captured.
  //
  // Two outcomes, and the difference is recorded honestly in headline_status:
  //   composed        — an unambiguous factual assertion was found and restated in our own wording
  //   rewrite_pending — no assertion could be extracted without inventing one, so the source's
  //                     wording stands in (attributed on screen) until the model rewrites it.
  // The source wording is NEVER relabelled as Catalyst Pit's own work just because it was cleaned.
  const built = composeHeadline({ headline: item.title, summary: item.summary, tickers });
  const display = built ? canonicalHeadline(built.headline, tickers) : canonicalHeadline(item.title, tickers);
  const factSig = factSignature(`${item.title} ${item.summary || ''}`);
  return {
    source: feed.source,
    source_name: feed.sourceName || feed.source,
    source_kind: feed.kind || 'external',
    source_type: feed.type,
    source_uid: item.uid,
    // headline is the DISPLAY headline — deterministically normalised now, refined by Haiku later.
    // source_headline keeps the source's exact words permanently, whatever happens afterwards.
    headline: display || item.title,
    // The source's exact words, permanently. When a feed declares `strip`, item.title has had the
    // channel's own watermark removed for display and dedupe — sourceTitle is the untouched line.
    source_headline: item.sourceTitle || item.title,
    summary: item.summary,
    published_at: item.publishedAt,
    original_url: item.url,
    // Tickers the SOURCE ITSELF stated are facts, not inferences, so they are trusted immediately.
    // Everything else waits for the conservative resolver.
    tickers,
    entity: entityToken(item.title, tickers),
    fact_sig: factSig,
    norm_hash: normHash(item.title),
    // The display headline's own hash. Ingest-time dedupe keys off the SOURCE's wording, which is
    // blind to four language editions of one press release all rendering as the same sentence.
    display_hash: normHash(display || item.title),
    category: feed.category || categoryOf(feed.source),
    // A trusted source cannot fall below HIGH. The scorer reads content, and a terse terminal flash
    // reads as unremarkable to it — "*GERMANY TO LOBBY EU ON NEW CHINA POLICY, MAY SEEK MORE
    // TARIFFS" scored 0, as did 18 of the first 19 posts from this source, which put every one of
    // them under the Market Moving preset's impact filter. The floor raises; it never lowers, so a
    // flash the scorer independently judges CRITICAL still comes through as CRITICAL.
    importance: feed.trusted
      ? Math.max(TRUSTED_MIN_IMPORTANCE, scoreImportance({ headline: item.title, summary: item.summary, source: feed.source, sourceType: feed.type, tickers }))
      : scoreImportance({ headline: item.title, summary: item.summary, source: feed.source, sourceType: feed.type, tickers }),
    content_hash: contentHash({ source: feed.source, title: item.title, publishedAt: item.publishedAt }),
    // isDisplayable rejects a headline under 12 characters or three words. A trusted wire is taken
    // at its word: any non-empty post it publishes is an event, and "capture every valid post"
    // cannot be subject to a length heuristic.
    //
    // LANGUAGE IS DIFFERENT, and it overrides even a trusted wire. Pit Wire publishes one English
    // Catalyst line; raw foreign source text is not that line, and no amount of trust in the
    // publisher makes it readable. The row is still ingested in full — headline, source_headline,
    // summary, url, provenance, cluster membership — it is only held OUT OF THE PUBLIC VIEW until a
    // real English headline exists for it, which runEnrichment re-checks on every rewrite.
    display_ready: !isNonEnglish(item.title, item.summary)
      && (feed.trusted ? true : isDisplayable(item.title)),
    // A feed marked rewrite:false keeps the source headline forever, so it is already final.
    headline_status: feed.rewrite === false ? 'not_required' : (built ? 'composed' : 'rewrite_pending'),
    pipeline_status: feed.rewrite === false ? 'ready' : 'pending',
    raw: { feed: feed.key, adapter: feed.adapter || 'rss', ...item },
  };
}

// Conditional GET. A 304 means nothing changed and costs no body transfer, which is what makes a
// 60-second cadence affordable.
// Metered APIs take their key as a query parameter. It is read from the environment at request time
// and never stored, logged or committed; `authQuery` only names which variable to read.
export function feedUrl(feed) {
  if (!feed.authQuery) return feed.url;
  const u = new URL(feed.url);
  for (const [param, envVar] of Object.entries(feed.authQuery)) {
    const v = process.env[envVar];
    if (v) u.searchParams.set(param, v);
  }
  return u.toString();
}

export async function fetchFeed(feed, state) {
  // Per-feed headers let a JSON/API source carry its own key without any other code knowing.
  const headers = { ...UA, ...(feed.headers || {}) };
  if (state?.etag) headers['If-None-Match'] = state.etag;
  if (state?.last_modified) headers['If-Modified-Since'] = state.last_modified;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(feedUrl(feed), { headers, signal: ctl.signal, cache: 'no-store' });
    // A metered API answers 402/429 when the allowance is gone. Treated as a normal failure so the
    // existing backoff parks the feed until the daily reset rather than hammering it.
    if (r.status === 402 || r.status === 429) {
      return { status: r.status, items: [], error: `quota/rate limited (HTTP ${r.status})`, quotaHit: true };
    }
    if (r.status === 304) return { status: 304, items: [], etag: state?.etag, lastModified: state?.last_modified };
    if (!r.ok) return { status: r.status, items: [], error: `HTTP ${r.status}` };
    const body = await r.text();
    // Adapter dispatch: the ONLY place the wire format matters. Everything after this point sees
    // one item shape regardless of whether the source spoke RSS, Atom or JSON.
    const { runAdapter } = await import('./news-adapters.mjs');
    return {
      status: r.status,
      items: runAdapter(body, feed),
      etag: r.headers.get('etag'),
      lastModified: r.headers.get('last-modified'),
    };
  } catch (e) {
    return { status: 0, items: [], error: String(e?.message || e).slice(0, 120) };
  } finally { clearTimeout(timer); }
}
