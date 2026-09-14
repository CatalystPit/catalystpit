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
function rssAdapter(body, feed) {
  return parseFeed(body, feed.url);
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
    const title = text(tm[1].replace(/<br\s*\/?>/gi, ' ').replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1'));
    const dm = chunk.match(/<time[^>]+datetime="([^"]+)"/);
    if (!title) continue;
    out.push({
      title,
      url: `https://t.me/${post}`,
      uid: post,
      publishedAt: parseDate(dm?.[1]),
      summary: null,                  // a channel post is a single line; there is no separate body
      tickers: [],                    // never inferred here
    });
  }
  return out;
}

export const ADAPTERS = { rss: rssAdapter, atom: rssAdapter, json: jsonAdapter, api: jsonAdapter, telegram: telegramAdapter };

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
      return {
        title: applyStrip(raw, feed),
        sourceTitle: raw,
        url: String(it.url || '').trim(),
        uid: String(it.uid || it.url || '').trim(),
        publishedAt: it.publishedAt ?? null,
        summary: it.summary ?? null,
        tickers: Array.isArray(it.tickers) ? it.tickers : [],
      };
    }).filter((it) => it.title && it.url);
  } catch { return []; }        // a malformed payload yields no items; it never breaks the pass
}
