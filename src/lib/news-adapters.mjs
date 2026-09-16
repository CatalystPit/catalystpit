// Source adapters. PURE: given bytes and a feed definition, produce normalized items.
//
// The whole point of this file is that NOTHING downstream knows what kind of source an item came
// from. Every adapter returns the same shape:
//
//   { title, url, uid, publishedAt, summary, tickers? }
//
// so adding a source is a registry entry, never a code change in the pipeline. `tickers` is only
// ever populated when the SOURCE ITSELF states them — it is a stated fact, not an inference.

import { parseFeed } from './primary-sources.mjs';

// ── shared helpers ───────────────────────────────────────────────────────────
// A date the source did not actually state is worse than no date, so anything unparseable or
// outside a sane window becomes null rather than a fabricated timestamp.
const SANE_FROM = Date.parse('2000-01-01');
export const parseDate = (raw) => {
  if (raw == null || raw === '') return null;
  // Numeric epochs arrive as seconds or milliseconds depending on the API.
  let t;
  if (typeof raw === 'number' || /^\d{10}$|^\d{13}$/.test(String(raw).trim())) {
    const n = Number(raw);
    t = String(Math.trunc(n)).length <= 10 ? n * 1000 : n;
  } else {
    t = Date.parse(String(raw).trim());
  }
  if (!Number.isFinite(t)) return null;
  if (t < SANE_FROM || t > Date.now() + 2 * 86400000) return null;
  return new Date(t).toISOString();
};

// "data.articles" / "items[0].title" → value. Returns undefined rather than throwing on any miss,
// because a source changing its shape must degrade to "no item", never to a crashed pass.
export function pick(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null) return undefined;
    const m = /^(.*?)\[(\d+)\]$/.exec(seg);
    if (m) {
      cur = m[1] ? cur[m[1]] : cur;
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(m[2])];
    } else {
      cur = cur[seg];
    }
  }
  return cur;
}

// Character references are a wire-format concern, so they are resolved here rather than leaking
// into stored provenance as raw "&amp;".
const decode = (s) => String(s)
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return decode(v.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
};

/**
 * Like text(), but keeps the line structure a message was written with.
 *
 * text() collapses every run of whitespace, newlines included, which is right for a headline and
 * wrong for a post that was authored in sections. This keeps <br> and paragraph boundaries as real
 * newlines while still collapsing runs of spaces and tabs WITHIN a line, so nothing gains an
 * artificial break: a message with no <br> comes back byte-identical to text() on the same input.
 */
const multiline = (v) => {
  if (typeof v !== 'string') return text(v);
  const withBreaks = v
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  return decode(withBreaks)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')        // spaces and tabs collapse; newlines do not
    .replace(/ *\n */g, '\n')         // no trailing or leading spaces around a break
    .replace(/\n{3,}/g, '\n\n')       // at most one blank line between sections
    .trim();
};

const absolute = (href, base) => {
  const h = text(href);
  if (!h) return '';
  if (/^https?:/i.test(h)) return h.replace(/^http:\/\//i, 'https://');
  try { return new URL(h, base).toString().replace(/^http:\/\//i, 'https://'); } catch { return ''; }
};

// Only symbols the source explicitly published. Shape varies wildly between APIs: ["AAPL"],
// [{symbol:'AAPL'}], "AAPL,MSFT". Anything we cannot read as a plain symbol is dropped, never guessed.
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
export function statedTickers(v) {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\s]+/) : v ? [v] : [];
  const out = [];
  for (const entry of raw) {
    const sym = String(
      entry && typeof entry === 'object' ? (entry.symbol ?? entry.ticker ?? entry.code ?? '') : entry,
    ).trim().toUpperCase();
    if (SYMBOL_RE.test(sym) && !out.includes(sym)) out.push(sym);
  }
  return out.slice(0, 8);
}

// ── adapters ─────────────────────────────────────────────────────────────────
// RSS / Atom. Delegates to the existing, already-verified parseFeed; kept as a named adapter so
// XML sources sit in the same registry as everything else.
// Venues Catalyst Pit covers. A symbol from anywhere else is a real symbol on a market we do not
// carry, so publishing it would produce a cashtag with no page behind it.
const US_VENUES = new Set(['NASDAQ', 'NYSE', 'NYSE AMERICAN', 'NYSEAMERICAN', 'NYSE ARCA', 'AMEX', 'CBOE']);

// SOME RSS FEEDS STATE SYMBOLS STRUCTURALLY rather than only in prose. Newsfile tags each release
// with one <category domain="…/stocksymbol"> per listing:
//
//   <category domain="…/stocksymbol">NASDAQ:HIVE</category>
//   <category domain="…/stocksymbol">TSX:HIVE</category>
//   <category domain="…/stocksymbol">ISIN:CA4339211035</category>
//
// That is the source stating a fact, which is the standard this pipeline accepts — but it states
// several, most of them on venues we do not cover, and one of them is not a symbol at all. So the
// exchange qualifier is READ rather than discarded: only US venues survive, ISIN and every foreign
// listing are dropped, and what is left still goes through statedTickers() for shape. A feed opts in
// with `symbolCategories: true`; no other feed changes behaviour.
const SYMBOL_CATEGORY = /<category\b[^>]*\bdomain\s*=\s*["'][^"']*stocksymbol[^"']*["'][^>]*>([\s\S]*?)<\/category>/gi;

function symbolCategoriesOf(block) {
  const out = [];
  SYMBOL_CATEGORY.lastIndex = 0;
  for (const m of String(block).matchAll(SYMBOL_CATEGORY)) {
    const raw = text(m[1]);
    const i = raw.indexOf(':');
    if (i < 1) continue;                                  // no venue qualifier: not enough to trust
    const venue = raw.slice(0, i).trim().toUpperCase();
    if (!US_VENUES.has(venue)) continue;                  // ISIN, TSX, TSX-V, FSE, CNSX, OTC tiers …
    out.push(raw.slice(i + 1).trim().toUpperCase());
  }
  return statedTickers(out);
}

function rssAdapter(body, feed) {
  const items = parseFeed(body, feed.url);
  if (!feed.symbolCategories) return items;
  // parseFeed does not carry <category> through, so the blocks are re-read here with the SAME split
  // parseFeed uses and matched back by title, which is what the two have in common.
  const blocks = String(body || '').match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || [];
  const byTitle = new Map();
  for (const blk of blocks) {
    const t = text((blk.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    if (t && !byTitle.has(t)) byTitle.set(t, symbolCategoriesOf(blk));
  }
  return items.map((it) => {
    const syms = byTitle.get(it.title) || [];
    return syms.length ? { ...it, tickers: syms } : it;
  });
}

// JSON. `feed.map` names where the fields live; anything absent is simply absent.
//   map: { items:'data.articles', title:'headline', url:'link', uid:'id',
//          publishedAt:'published_utc', summary:'description', tickers:'symbols' }
function jsonAdapter(body, feed) {
  let doc;
  try { doc = typeof body === 'string' ? JSON.parse(body) : body; } catch { return []; }
  const map = feed.map || {};
  const rows = map.items ? pick(doc, map.items) : (Array.isArray(doc) ? doc : doc?.items ?? doc?.data ?? doc?.results);
  if (!Array.isArray(rows)) return [];

  const out = [];
  for (const row of rows) {
    const title = text(pick(row, map.title || 'title'));
    const url = absolute(pick(row, map.url || 'url'), feed.url);
    if (!title || !url) continue;                       // an item we cannot link to is not usable
    const summary = text(pick(row, map.summary || 'summary'));
    out.push({
      title,
      url,
      uid: text(pick(row, map.uid || 'id')) || url,
      publishedAt: parseDate(pick(row, map.publishedAt || 'published')),
      // A source that repeats the headline as the description has not written a summary.
      summary: summary && summary !== title ? summary.slice(0, 1200) : null,
      tickers: statedTickers(pick(row, map.tickers)),
    });
  }
  return out;
}

// Telegram public channel preview (https://t.me/s/<channel>). This is Telegram's own public,
// unauthenticated HTML preview of a public channel — the same page any browser gets with no login.
// No auth, no token, no private API. Parsed rather than fetched as a feed because Telegram publishes
// no RSS; the markup is stable and every field taken is one the page states outright.
function telegramAdapter(body, feed) {
  const html = String(body || '');
  const out = [];
  // Each message exposes its channel-relative id in data-post, which is a perfect stable uid.
  for (const m of html.matchAll(/data-post="([^"]+)"([\s\S]{0,6000}?)<\/div>\s*<\/div>/g)) {
    const post = m[1], chunk = m[2];
    const tm = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!tm) continue;
    const inner = tm[1].replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');
    // `title` is produced EXACTLY as before — flat, <br> to a space. Everything derived from it is
    // therefore byte-identical: content_hash, norm_hash, entity, the fact signature, the display
    // headline, Pit Wire and the whole X pipeline. Nothing about selection or dedupe moves.
    const title = text(inner.replace(/<br\s*\/?>/gi, ' '));
    // `sourceTitle` is the same line with its structure intact, which normalize() records as
    // source_headline — "the source's exact words, permanently". Telegram renders every line break
    // as <br/>, and flattening them turned Walter's structured WHAT TO WATCH TODAY posts into a wall
    // of text on Facebook. A post with no <br> yields a string identical to `title`, so ordinary
    // one-line flashes are untouched.
    const sourceTitle = multiline(inner);
    const dm = chunk.match(/<time[^>]+datetime="([^"]+)"/);
    if (!title) continue;
    out.push({
      title,
      sourceTitle,
      url: `https://t.me/${post}`,
      uid: post,
      publishedAt: parseDate(dm?.[1]),
      summary: null,                  // no separate body: a channel post is one message, structure and all
      tickers: [],                    // never inferred here
    });
  }
  return out;
}

// ── Google News sitemap ──────────────────────────────────────────────────────
// A news sitemap is <url> blocks carrying a <news:news> record, not <item> blocks, so the RSS
// reader sees nothing in one. It exists here because some publishers no longer expose RSS at all:
// Barchart serves every feed-shaped path through a CloudFront bot challenge that answers 202 with
// an empty body, while this file is served straight from origin and carries the same newsroom.
//
// The format gives exactly what an item needs — canonical URL, title and a real ISO publication
// date — and one thing that is deliberately NOT taken. <news:stock_tickers> is present, but on a
// commodities story it reads "HEZ26,HEV26,HEG27": lean-hogs futures contracts, not equities.
// Importing those would put contract codes in the ticker field and, downstream, cashtags for
// securities that do not trade under those symbols. The canonical resolver reads the headline
// instead, and refuses what it cannot place — no ticker beats a wrong ticker.
function sitemapAdapter(body, feed) {
  const blocks = String(body || '').match(/<url\b[\s\S]*?<\/url>/gi) || [];
  const out = [];
  for (const b of blocks) {
    // Namespaced tags are matched with an optional prefix so a feed that drops the "news:" prefix,
    // or uses another one, still reads.
    const tag = (name) => {
      const m = b.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/\s+/g, ' ').trim() : '';
    };
    const url = tag('loc');
    const title = tag('title');
    if (!url || !title) continue;
    out.push({
      title,
      url,
      uid: url,
      publishedAt: parseDate(tag('publication_date') || tag('lastmod')),
      summary: null,               // a sitemap carries no body text
      tickers: [],                 // see above: never imported
    });
  }
  return out;
}

export const ADAPTERS = { rss: rssAdapter, atom: rssAdapter, json: jsonAdapter, api: jsonAdapter, telegram: telegramAdapter, sitemap: sitemapAdapter };

// Some wires sign every line: FinancialJuice ends each post "|FJ", Walter Bloomberg appends
// "(@WalterBloomberg)". That is the channel's watermark, not part of the event, and leaving it in
// puts it on screen and dilutes the text the cross-source dedupe compares. A feed therefore declares
// its own `strip` patterns rather than any adapter learning about a particular source. The ORIGINAL
// line survives untouched as `sourceTitle`, which is what normalize() records as source_headline.
function applyStrip(title, feed) {
  if (!feed.strip?.length) return title;
  let s = title;
  for (const re of feed.strip) s = s.replace(re, ' ');
  s = s.replace(/\s+/g, ' ').replace(/[\s|·\-–—]+$/, '').trim();
  return s || title;            // never let a greedy pattern delete the whole headline
}

export function runAdapter(body, feed) {
  const fn = ADAPTERS[feed.adapter || 'rss'];
  if (!fn) return [];
  try {
    const items = fn(body, feed) || [];
    // Normalize the contract so downstream code never has to defend against a sloppy adapter.
    return items.map((it) => {
      const raw = String(it.title || '').trim();
      // An adapter MAY supply its own sourceTitle when the source's own text carries structure that
      // `title` cannot: the Telegram adapter emits the message with its line breaks intact, while
      // title stays flat so every hash, the display headline and the X pipeline are unaffected.
      //
      // This line used to be `sourceTitle: raw`, which silently threw that away and rebuilt it from
      // the flattened title — so the adapter did the work and the normaliser undid it, and Walter's
      // multi-line posts still reached the Page as a wall of text. Defaulting to `raw` keeps every
      // other adapter byte-identical.
      const structured = it.sourceTitle == null ? raw : String(it.sourceTitle).trim();
      return {
        title: applyStrip(raw, feed),
        sourceTitle: structured,
        url: String(it.url || '').trim(),
        uid: String(it.uid || it.url || '').trim(),
        publishedAt: it.publishedAt ?? null,
        summary: it.summary ?? null,
        tickers: Array.isArray(it.tickers) ? it.tickers : [],
      };
    }).filter((it) => it.title && it.url);
  } catch { return []; }        // a malformed payload yields no items; it never breaks the pass
}
