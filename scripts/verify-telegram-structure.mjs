// TELEGRAM STRUCTURE: a Walter post reaches Facebook laid out the way it was written, and nothing
// else in the pipeline notices.
//
// Telegram renders every line break as <br/>. The adapter turned each one into a space, so a
// structured "WHAT TO WATCH TODAY" post — headings, schedule lines, blank lines between sections —
// arrived on the Page as one wall of text. Measured before the fix: 114 ingested Walter events, 0
// containing a newline, all the way down to fb_post_candidates.message.
//
// The fix adds `sourceTitle` and leaves `title` alone, because `title` is what content_hash,
// norm_hash, entity, the fact signature, the display headline and the entire X pipeline are built
// from. THE ASSERTION THAT MATTERS MOST is that title is byte-identical to what it was.
//
//   node scripts/verify-telegram-structure.mjs

import { ADAPTERS, runAdapter } from '../src/lib/news-adapters.mjs';
import { facebookText } from '../src/lib/facebook-post.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);

// One Telegram message as the widget serves it. The real markup: a data-post id, the message text
// div, a <time>, and <br/> for every line break.
const msg = (id, html) => `<div class="tgme_widget_message" data-post="WalterBloomberg/${id}">`
  + `<div class="tgme_widget_message_text js-message_text">${html}</div>`
  + `<time datetime="2026-09-16T12:00:00+00:00"></time></div></div>`;

const STRUCTURED_HTML = [
  '🇺🇸 WHAT TO WATCH TODAY — U.S. MARKETS', '<br/>', '<br/>',
  '🔥 FED — KEY EVENT', '<br/>',
  '🎙 WARSH — 2:30 PM ET', '<br/>', '<br/>',
  '8:30 AM ET — 🇺🇸 Retail Sales', '<br/>',
  '8:30 AM ET — 🇺🇸 Import &amp; Export Prices', '<br/>',
  '10:30 AM ET — 🛢 OIL', '<br/>', '<br/>',
  '🌍 GLOBAL WATCH', '<br/>',
  'China industrial output slows', '<br/>', '<br/>',
  '(@WalterBloomberg)',
].join('');
const ONE_LINE_HTML = 'SK HYNIX SAYS IT WILL SUPPLY HBM4 TO INTEL (@WalterBloomberg)';

const feed = { key: 'telegram_walterbloomberg', source: 'WALTERBLOOMBERG', adapter: 'telegram' };
// THROUGH runAdapter, NOT the adapter in isolation. The first version of this file called
// ADAPTERS.telegram directly, so it never saw that runAdapter overwrote sourceTitle with the
// flattened title — 33 assertions passed while production published a wall of text. Always test
// the path production actually takes.
const parse = (html) => runAdapter(msg('9001', html), feed)[0];
const parseRawAdapter = (html) => ADAPTERS.telegram(msg('9001', html), feed)[0];

section('1. the structured post keeps its structure');
{
  const item = parse(STRUCTURED_HTML);
  ok('the message parsed', !!item, 'adapter returned nothing');
  const st = item.sourceTitle;
  ok('sourceTitle exists', typeof st === 'string' && st.length > 0);
  ok('it has real line breaks', (st.match(/\n/g) || []).length >= 8, (st.match(/\n/g) || []).length + ' newlines');
  ok('blank lines between sections survive', /\n\n/.test(st));
  // Each heading must start its own line, not be buried mid-sentence.
  for (const h of ['🔥 FED — KEY EVENT', '🎙 WARSH — 2:30 PM ET', '🌍 GLOBAL WATCH'])
    ok(`"${h}" starts its own line`, new RegExp('(^|\\n)' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(st));
  // Schedule lines stay separate.
  const lines = st.split('\n');
  ok('the two 8:30 AM lines are separate lines',
    lines.filter((l) => l.startsWith('8:30 AM ET')).length === 2, JSON.stringify(lines.filter((l) => l.includes('8:30'))));
  ok('no line runs two schedule entries together', !lines.some((l) => (l.match(/AM ET/g) || []).length > 1));
  ok('entities are decoded', st.includes('Import & Export') && !st.includes('&amp;'));
  ok('no leading/trailing space on any line', lines.every((l) => l === l.trim()));
  ok('never more than one blank line in a row', !/\n\n\n/.test(st));
}

section('2. what Facebook would actually publish');
{
  const item = parse(STRUCTURED_HTML);
  const out = facebookText({ source_headline: item.sourceTitle });
  const lines = out.split('\n');
  console.log(out.split('\n').map((l, i) => '    ' + String(i + 1).padStart(2) + '| ' + l).join('\n'));
  ok('multiline output reaches the Page', lines.length >= 9, lines.length + ' lines');
  ok('the trailing Walter attribution is gone', !/@WalterBloomberg/i.test(out));
  // Cased by the editorial pass now (see facebook-voice.mjs); the STRUCTURE is what this pins.
  ok('the heading is the first line', /what to watch today/i.test(lines[0]), lines[0]);
  ok('section structure is intact', /🔥 FED — key event\.\n🎙 Warsh/.test(out), JSON.stringify(out.slice(0, 120)));
  ok('wording is otherwise unchanged', out.includes('China industrial output slows'));
}

section('3. an ordinary one-line flash is NOT reformatted');
{
  const item = parse(ONE_LINE_HTML);
  ok('sourceTitle is a single line', !item.sourceTitle.includes('\n'), JSON.stringify(item.sourceTitle));
  // With no <br> present, the structured path must agree exactly with the flat one.
  ok('sourceTitle is byte-identical to title when there are no breaks',
    item.sourceTitle === item.title, JSON.stringify([item.title, item.sourceTitle]));
  const out = facebookText({ source_headline: item.sourceTitle });
  ok('the Facebook post is still one line', !out.includes('\n'), JSON.stringify(out));
  ok('it is the SK Hynix line, attribution stripped',
    out === 'SK Hynix says it will supply HBM4 to Intel.', JSON.stringify(out));
}

section('4. THE SAFETY PROPERTY: title is byte-identical to the old behaviour');
{
  // The exact expression the adapter used before this change.
  const decode = (s) => String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
  const legacyTitle = (html) => decode(
    html.replace(/<br\s*\/?>/gi, ' ').replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1').replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();

  for (const [label, html] of [['structured', STRUCTURED_HTML], ['one-line', ONE_LINE_HTML],
    ['with a link', 'BREAKING <a href="https://x.com">SOURCE</a> SAYS YES'],
    ['entity heavy', 'A &amp; B &lt;C&gt; &quot;D&quot;'],
    ['double break', 'ONE<br/><br/>TWO'],
    ['spaced break', 'ONE <br />  TWO']]) {
    const item = parse(html);
    ok(`${label}: title unchanged from the legacy expression`,
      item.title === legacyTitle(html), JSON.stringify([legacyTitle(html), item.title]));
  }
  // Which is what guarantees dedupe and clustering cannot move: content_hash lowercases and maps
  // every non-alphanumeric run to a single space, so even a newline in title would not change it —
  // but title does not change at all, so nothing downstream can.
  const a = parse(STRUCTURED_HTML), b = parse(ONE_LINE_HTML);
  ok('title carries no newline, as before', !a.title.includes('\n') && !b.title.includes('\n'));
  ok('the adapter still returns a uid and url', !!a.uid && /^https:\/\/t\.me\//.test(a.url));
  ok('summary stays null', a.summary === null);
  ok('tickers are still never inferred here', Array.isArray(a.tickers) && a.tickers.length === 0);
}

section('5. the X pipeline is unaffected by construction');
{
  // X reads the DISPLAY headline, which is built from `title`, and collapses whitespace itself.
  const item = parse(STRUCTURED_HTML);
  ok('X-facing title has no structure to collapse', !item.title.includes('\n'));
  ok('sourceTitle is a separate field, not a replacement',
    item.title !== item.sourceTitle && typeof item.title === 'string');
}

section('6. runAdapter must not flatten what the adapter structured');
{
  // THE BUG THIS SECTION EXISTS FOR. runAdapter rebuilt sourceTitle from the flattened title:
  //
  //     sourceTitle: raw,        // raw = String(it.title).trim()
  //
  // so the adapter produced the structure and the normaliser discarded it. Nothing downstream ever
  // saw a newline. It shipped because the tests above called ADAPTERS.telegram directly.
  const viaAdapter = parseRawAdapter(STRUCTURED_HTML);
  const viaRunAdapter = parse(STRUCTURED_HTML);
  ok('the adapter produces structure', viaAdapter.sourceTitle.includes('\n'));
  ok('runAdapter PRESERVES it', viaRunAdapter.sourceTitle.includes('\n'),
    JSON.stringify(viaRunAdapter.sourceTitle.slice(0, 80)));
  ok('it is the adapter\'s own value, unmodified',
    viaRunAdapter.sourceTitle === viaAdapter.sourceTitle);
  ok('title is still flat after runAdapter', !viaRunAdapter.title.includes('\n'));

  // With the PRODUCTION feed config: `strip` removes the watermark and the leading flash asterisk
  // from title for display and dedupe, and must not touch the source's own words.
  const prodFeed = { key: 'telegram_walterbloomberg', source: 'WALTERBLOOMBERG', adapter: 'telegram',
    strip: [/\s*\(\s*@?walter\s*bloomberg\s*\)/gi, /^\s*\*+\s*/] };
  const it = runAdapter(msg('9002', STRUCTURED_HTML), prodFeed)[0];
  ok('strip still cleans the display title', !/@WalterBloomberg/i.test(it.title));
  ok('the source line keeps its structure under the real config', it.sourceTitle.includes('\n'));
  ok('the source line is left verbatim, watermark and all', /@WalterBloomberg/i.test(it.sourceTitle));
  const flash = runAdapter(msg('9003', '*US 20Y BONDS DRAW 5.420% (@WalterBloomberg)'), prodFeed)[0];
  ok('a one-line flash still loses its asterisk in the display title', !flash.title.startsWith('*'));
  ok('and stays a single line everywhere', !flash.sourceTitle.includes('\n'));

  // Every other adapter must be byte-identical: they set no sourceTitle, so it falls back to title.
  const rssFeed = { key: 'r', source: 'S', adapter: 'rss' };
  const rss = runAdapter('<rss><channel><item><title>PLAIN HEADLINE</title>'
    + '<link>https://example.com/a</link></item></channel></rss>', rssFeed)[0];
  ok('an adapter that sets no sourceTitle is unchanged',
    rss && rss.sourceTitle === 'PLAIN HEADLINE' && rss.title === 'PLAIN HEADLINE');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
