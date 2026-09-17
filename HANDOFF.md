# Catalyst Pit — session handoff

**Last updated:** 2026-09-17 08:50 ET · **HEAD:** see `git log -1` (this file is committed on top of
`16b62b7`) · `main`. Point a new session at this file (`read HANDOFF.md`), then check `git status` and
`git log --oneline -15`, because a commit made after this file was last updated won't be listed here.

---

## Where things stand right now

### 1. Chart / Terminal: waiting on the user's manual QA in production

Everything below is committed. Nothing is half-done. **Do not redo these fixes.** Wait for the user
to report back.

| Commit | What | Production status |
|---|---|---|
| `51f3320` | Repair Ray / Horizontal / Vertical geometry, explicit tool lifecycle | awaiting QA |
| `d2f3c13` | Popover joins the dismissal stack once mounted. **This was the real reason** Ray/Horizontal/Vertical couldn't be armed from the Lines flyout (the menu closed on mousedown before the row's click landed). | awaiting QA |
| `c574476` | Legend: indicator collapse control sits under the last indicator row | awaiting QA |
| `0d80670` | Legend: collapse control is a visible chip in dark mode (4 new theme tokens) | awaiting QA |
| `2c42720` | Lower indicator panes (RSI/MACD/ATR) open compact, sized by share, drags persist (`chart-panes.mjs`) | awaiting QA |
| `eb7c58f` | Ticker About: company description slot, **renders nothing** until a real source exists | nothing visible by design |
| `16b62b7` | Housekeeping: raw control chars in company-description files → escapes (git saw them as binary) | no behaviour change |

What the user should check: the three line tools pick and draw from the Lines flyout; the legend
control's position and dark-mode visibility; RSI/MACD/ATR open compact and dragged heights survive
ticker/timeframe/theme change and reload; the ticker About card looks exactly as before.

Previously confirmed working in production by the user: Fibonacci, Terminal panel resizing,
Trendline (incl. future space), typed timeframe entry.

The earlier caveat ("couldn't reproduce a Horizontal/Vertical *creation* failure, cause must be
browser-side") was resolved by `d2f3c13`. If a line tool still misbehaves, start from Popover
dismissal and the tool lifecycle, not the geometry (covered by tests).

### 2. Company descriptions: SEC investigation done, validation is the NEXT TASK

**Status (agreed with the user):**

- The UI slot exists (`eb7c58f`): `src/lib/company-description.mjs` (normaliser),
  `src/components/CompanyDescription.jsx`, wired into `TickerPage.jsx` About. It renders nothing
  without `data.description`, so nothing is displayed today.
- **No legitimate description source is connected. No backfill has run. No product implementation
  until extraction quality is measured.**
- Catalyst Pit's current SEC usage: submissions API, XBRL companyfacts, `company_tickers.json`, and
  filing documents/indexes for Form 4, 13F and 8-K. We do **not** fetch, store or parse 10-K text or
  Item 1 Business.
- SEC structured APIs have no short business-description field.
- Finnhub profile2 (the About facts) has no description. Polygon v3 ticker-details returns one, but it
  is discarded and its public-display rights under our plan are unconfirmed, so **don't use it**.
- Item 1 Business looks promising for U.S. operating companies, but its reliability is **unmeasured**.
- Estimated useful SEC coverage: roughly 4,000–5,000 U.S. operating companies.
- ETFs need a different source. Foreign issuers need different handling (20-F Item 4.B; 40-F puts the
  business description in an exhibit, the Annual Information Form). SPACs and unusual/multi-registrant
  filings are special cases.
- **Proposed architecture (not committed to):** hybrid. PRIMARY: SEC-derived descriptions for
  eligible U.S. operating companies. FALLBACK LATER: a licensed commercial provider for ETFs, foreign
  issuers, extraction failures and unsupported securities. Storage, if we proceed: issuer-level, keyed
  by **CIK**, with full provenance (accession, form, filing date, section, extraction version). Not
  per ticker.
- **No AI summarization initially.** The candidate is deterministic extraction of a concise *verbatim*
  factual excerpt from Item 1. An AI layer needs explicit user approval and should only be considered
  if deterministic quality is insufficient.

**NEXT TASK: validate Item 1 extraction quality on ~200 representative companies** before committing
to the architecture. The sample should span market caps, sectors, banks, biotech, industrials, utilities,
holding companies, multi-segment businesses, long/short Item 1, SPACs, new and old companies, and
different filing structures. Classify every result:

- **GOOD**: usable on the About card as is
- **TRIM**: right content, trimming needs work
- **WRONG**: wrong section, TOC, boilerplate, unrelated
- **NO RESULT**: couldn't confidently extract
- **SPECIAL CASE**: correct extraction, but the issuer structure makes it unsuitable as a normal description

Report: attempted, fetch successes and failures, count and % per class, recurring failure patterns,
and practical universe coverage.

**Execution environment: decide first.** This machine's SEC access returned 403 / Access Denied
(to the previous session and to the user's own local probe). That was SEC/Akamai, not a sandbox: no
Claude Code sandbox or network restriction is configured, and non-SEC hosts return 200. **Do not
hammer SEC from here.** At most one probe per 10 minutes (the pattern in
`scripts/resume-when-sec-clears.sh`). Requirements for any run: company-identifying User-Agent,
conservative throttle well under SEC's 10 req/s, retry with backoff, stop on persistent 403/429, no
concurrency, cache every download (never refetch), no production DB writes, no public SEC proxy
endpoint, no backfill, no user-facing change, and remove any temporary infrastructure afterwards.
Don't force Vercel if it's a poor fit (see the environment-decision notes, if present, at the end of
this file).

Prior-session artefacts (outside the repo, may be cleaned up by the OS):
`%TEMP%\claude\C--Users-bcogh\6313d637-…\scratchpad\sec-item1-probe.mjs` (a 13-company local probe
with a naive `^item 1 business$` heading regex plus a longest-candidate TOC heuristic). Its only output
was a run where `company_tickers.json` yielded 0 entries, followed by 403s. **Zero companies were
actually measured.** `coverage-probe.mjs` has read-only DB count queries; no saved output.

---

## The project

Next.js 15 (App Router) / Neon Postgres / Drizzle / Clerk / Vercel. A market-intelligence product.
Working dir `C:\Users\bcogh\Documents\dev\catalystpit`. Mixed LF/CRLF line endings throughout.

| Area | State |
|---|---|
| **Chart** | Feature-complete at `e4e2480`; in manual QA. Fix batches in scope, new features are not. |
| **Pit Scan / scanner** | Engine complete at `048e223`. Not connected to live provider data yet. |
| **Terminal** | Panel resizing rebuilt at `b34731e`. |
| **Company descriptions** | UI slot only (`eb7c58f`). Source undecided; SEC Item 1 validation is next. |

The user's workflow: they test in production, then send a focused fix batch. Each batch ends with
"Then STOP so I can manually test." Honour that: finish the batch, verify, commit/push, report, stop.
Pushing to `main` triggers a Vercel deploy.

---

## Standing constraints (the user has repeated these; treat as permanent)

- **Never expose, print, log, echo or return tokens, credentials, or secrets.** Don't touch Meta
  configuration or Vercel environment variables.
- **Do not touch Facebook. Do not touch X.** Stated in essentially every task.
- **Never fabricate market data.** Only use Catalyst Pit data sources/endpoints that exist today and
  that we're permitted to display. No fake timeframes, no fake real-time, no fake live data in
  production. Don't present delayed or incomplete data as real-time/consolidated. The same applies to
  company descriptions: nothing shown without a legitimate, attributable source.
- **Do not reopen chart feature development.** Deliberately deferred until the commercial market-data
  provider is chosen: chart alerts, real-time streaming, consolidated volume, weekly/monthly bars,
  extended hours beyond intraday, futures/options/FX/crypto. Explicitly unwanted: exotic drawing
  tools (Gann, pitchfork) and a multi-chart layout system (the Terminal owns panel layout).
- **Follow TradingView Lightweight Charts licensing/attribution correctly.** Never copy TradingView
  branding, logos or proprietary assets.
- **Keep the Custom Scanner's Finviz-style compact dropdown UX.** Do not replace it with a generic
  `Field | Operator | Value` rule-builder. The engine may use that model internally; the UX must not.
- **Do not remove the legacy scanner path yet** (`CustomScannerBody`, `PitScanBody`,
  `/api/scan?mode=pit`, `lib/pitscan.js`). Retire only after the replacement is connected to live
  provider data and proven stable.
- **Don't touch market-data provider integration** unless the task is explicitly about it.
- **Don't hide an exception behind another try/catch** without fixing the underlying cause.
- **Don't roll back architecture** to make a symptom go away.

---

## Verification discipline: this is the important part

Suites that must pass before any deploy (counts at `16b62b7`, all 0 failed):

```bash
node scripts/verify-chart.mjs                 # 1330
node scripts/verify-scan.mjs                  # 287
node scripts/verify-terminal.mjs              # 122
node scripts/verify-render.mjs                # 40
node scripts/verify-ticker-urls.mjs           # 187  (ticker page work)
node scripts/verify-company-description.mjs   # 51   (About description)
```

`scripts/` has ~47 `verify-*.mjs` suites in total; run the ones for the area you touch.

A complete production build needs dummy Clerk keys, or it dies at prerender before reaching
`/terminal`:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk \
CLERK_SECRET_KEY=sk_test_00000000000000000000000000000000 \
npx next build
```

### Every new assertion is mutation-tested before it is trusted

Break the behaviour in the source, confirm the suite prints a `FAIL` naming *that* assertion, restore.
Scratchpad harnesses (`mut*.cjs`) automate it. This is not optional ceremony. It has repeatedly
caught assertions that could never fail:

- matching their own explanatory comment (a negative regex defeated by the sentence explaining the
  removal)
- satisfied by a different part of the same file, or by a sibling component
- `indexOf` returning `-1` making an order check pass vacuously
- a symmetric sample making median == mean, so "uses median" couldn't fail
- a fixture whose outlier sat outside the window the function actually reads
- `x + w is unchanged`: true even with the clamp removed, since x runs one way and w the other
- checks bound to module constants instead of the requirement's literal values (unfalsifiable)
- a trailing U+FEFF in a "control chars are stripped" test: `trim()` removes it anyway
- a mutation that silently didn't apply (`sed` reading `\x00` as a real NUL byte). Do mutations
  with Node string replacement and check the pattern was actually found.

**The recurring killer: tests that CRASH instead of failing.** A throw ends the run and silences
every assertion after it, which makes a genuinely broken feature look untested. Guard every
dereference; use the `seg0()` / sentinel-drawing helpers in `verify-chart.mjs`. `ok()`'s third
argument (the diagnostic) is evaluated **eagerly**, so it must survive the failure it describes.

**Prefer measuring behaviour to matching source.** The newest sections drive pure geometry modules
through a deterministic stand-in for the browser API and assert the pixels that would be drawn;
`verify-render` mounts the real `DrawingRail` with react-dom/client and delivers mousedown-then-click;
section 35 of `verify-chart` reproduces Lightweight Charts' pane layout algorithm.

---

## Chart architecture: the parts that took work to learn

Lightweight Charts **v5.2**. `addSeries`, `panes()`/`setHeight`, `logicalToCoordinate`,
`coordinateToLogical`, `getVisibleLogicalRange`, `takeScreenshot()`.

### Anchors are moments, not bar indices (`chart-coords.mjs`)

An anchor is a **timestamp**: inside the data it's the bar's own time (so stored drawings are
byte-identical), beyond it it's extrapolated from the **median** recent bar gap. A timestamp survives
new bars arriving and timeframe changes; an index doesn't.

### Endpoints resolve two ways and no other (`chart-project.mjs`)

Either a **data anchor** through the chart's scales, or a **viewport edge** in pixels. Manufacturing a
time from the visible range (`view.from` / `view.to`) is what broke Fibonacci, the horizontal line and
the ray: `timeToCoordinate()` returns null for anything that isn't an exact bar. Unplaceable geometry
is **counted** (`dropped`), so a test can assert zero. **Never reintroduce a fabricated time.** Use an
edge anchor or `extendToBox()`. `extendRay` was deleted.

The canvas is `inset:0` over the whole chart (covers price-scale gutter and time axis). Use
`plotSize()` (from `timeScale().width()/height()`), never the canvas box, never `canvas.height`.

### Tool lifecycle is explicit (`chart-tool-lifecycle.mjs`)

One-point tools (horizontal, vertical, text) commit on the **first** click and preview from the
pointer alone. Two-point tools (trend, ray, rectangle, fib, measure) commit on the second and preview
from their placed anchor. Committing **suppresses the chart's next click**; otherwise LWC's late click
hit-tests and deselects the drawing just made.

### Menus / Popover (`ChartUI.jsx`)

Every chart menu is portalled. The Popover registers in the dismissal stack (`openPanels`) only once
its panel is **actually mounted** (it renders on a second pass after `pos` is set). Keying that effect
on `open` alone made every menu treat a mousedown on its own row as an outside click (`d2f3c13`).

### Indicator panes (`chart-panes.mjs`)

Every pane is a **share** of the plot, applied as a stretch factor. Never `setHeight(px)` restored from
`getHeight()` across a redraw: LWC converts px against the panes' *current* heights, which are 0 right
after re-adding, so panes grew f → f/(1-f) on every redraw. Defaults: one lower pane 22%, two 36%,
three 45%, more capped at 50%; price pane never below half by default. Drags are read on pointer
release and before any teardown, saved per indicator instance in `cp_chart_view`, and clamped (LWC
30px floor, price pane ≥25%).

### Other chart modules

`chart-drawings.mjs` (tool registry, geometry, hit test), `chart-settings.mjs` (view prefs under
`cp_chart_view`), `chart-drawing-store.mjs` (per-symbol drawings), `chart-source.mjs` (provider seam;
every timeframe declares required bar resolution *and* display window; `barsUrl` refuses what the
adapter can't serve), `chart-history.mjs` (undo/redo), `chart-indicators.mjs`, `chart-theme.mjs`
(incl. `controlBg`/`controlBgHover`/`controlBorder`/`controlBorderHover`), `chart-types.mjs`,
`chart-popover.mjs`, `chart-export.mjs`, `chart-quick-timeframe.mjs`.

Components: `CPChart.jsx`, `DrawingLayer.jsx`, `DrawingRail.jsx`, `ChartLegend.jsx`, `ChartUI.jsx`,
`ChartMenu.jsx`, `IndicatorBrowser.jsx`, `DrawingManager.jsx`, `DrawingSettings.jsx`,
`SymbolSearch.jsx`, `TickerPriceChart.jsx`.

### The TDZ landmine: this took production down once

React evaluates hook **dependency arrays eagerly during render**. Listing a `useCallback` before its
own `const` throws `Cannot access 'X' before initialization` and takes the page to the error boundary.
`CPChart.jsx` has five callbacks deliberately declared *below* `patchView`; that ordering is
load-bearing. `verify-render.mjs` checks this statically and SSR-renders the real components; it does
**not** mount `DrawingLayer` (needs a live chart instance).

---

## Terminal architecture

`src/app/terminal/TerminalClient.jsx` (~1500 lines) + `src/lib/terminal/panel-resize.mjs`.

**Free-floating absolute positioning, not a grid.** Every panel is `{x, y, w, h, color}` in pixels and
panels may overlap. `react-grid-layout` was removed (needs `findDOMNode`, gone in React 19). Shared-border
resizing **derives** adjacency geometrically at pointer-down and stores nothing.

- **Keep the stored shape `{x, y, w, h}`.** Saved stations, `sigOf`, Reset and user layouts read it.
- Minimums are `MIN_W = 240, MIN_H = 220`. Reuse, don't invent.
- **Clamp the delta, not the result**, or a panel at its minimum slides across the screen.
- Layout persists to `localStorage` under `cp_terminal_layout`; stations go to `/api/stations`.

---

## Scanner architecture

`src/lib/scan/`: `market-capabilities.mjs`, `market-state.mjs`, `velocity.mjs`, `levels.mjs`,
`volume-baseline.mjs`, `lifecycle.mjs`, `signals.mjs`, `engine.mjs`, `pulse.mjs`, `filters.mjs`,
`presets.mjs`, `columns.mjs`, `enrichment.mjs`, `research.mjs`, `fixtures.mjs`, `runtime.js`,
`scanner-fields.mjs`, `relative-strength.mjs`.

Capability-gated: providers declare what they have; signals, filters and columns declare what they
need; anything unserviceable is refused rather than faked. Volume baselines use **median/MAD**.

**Next major scanner step (not started):** connect the selected commercial market-data provider.

---

## SEC access: what exists

- Production calls SEC **from Vercel** continuously: `/api/refresh?form4=1` and
  `/api/cron/primary-sources` every minute, `/api/cron/eightk` every 5 min, institutions/13F daily and
  hourly, plus on-demand `/api/earnings`, `/api/financials`, `/api/symbol-search`, `/api/ticker`.
  They all send the same company-identifying User-Agent (see `SEC_HEADERS` in `src/lib/eightk.js`).
- There is no shared SEC client or global throttle; each route sets its own headers.
- `scripts/resume-when-sec-clears.sh` shows a past block during 13F ingest: at most one probe every
  10 minutes, because polling harder extends a block.

---

## Environment pitfalls

- **The Write/Edit tools and Bash command strings decode backslash-u escapes into raw characters.**
  That is how raw NUL/ZWSP/BOM bytes got into `company-description.mjs` (fixed in `16b62b7`), and a
  raw U+2028 will break a regex. When source must contain such an escape, generate it from a Node
  script using `String.fromCharCode(92)` for the backslash, then check with
  `grep -cP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'` and `git ls-files --eol` (must say `i/lf`, not `-text`).
- **Bash heredocs mangle backslashes and backticks.** Write patch scripts containing regexes to a
  `.cjs` file in the scratchpad with the Write tool, then run with `node`.
- `$TMPDIR` is not set. Use the full scratchpad path.
- Source-matching scripts must normalise with `.replace(/\r\n/g, '\n')` first.
- No `eslint.config.*` exists, so `npx eslint` fails. The build is the lint signal.
- General outbound network works from this machine (no Claude Code sandbox is configured).
  **sec.gov specifically returns 403** to this machine's IP (see above).
- Vercel deploys can't be confirmed from here, and `npx vercel ls` hangs waiting for login. Don't
  run it. Say plainly that pushing to `main` triggers a deploy rather than claiming it succeeded.

---

## Commits this cycle

| Commit | What |
|---|---|
| `ec24aae` | Fix TDZ that took the Terminal down after `048e223` |
| `77c537e` | Future-space drawing, true horizontal lines, typed timeframe entry |
| `37e4ff1` | Fibonacci level rendering, horizontal line as plot-wide price level, collapsible indicator legend |
| `b34731e` | Terminal: resize from any edge/corner, shared borders |
| `51f3320` | Repair Ray / Horizontal / Vertical, explicit tool lifecycle |
| `d2f3c13` | Popover dismissal-stack fix: flyout tools can be armed |
| `c574476` | Legend collapse control under the last indicator row |
| `0d80670` | Legend collapse control as a dark-mode chip |
| `2c42720` | Indicator panes sized by share; drags persist |
| `eb7c58f` | Ticker About company-description slot (hidden until a real source) |
| `16b62b7` | Escape raw control chars in company-description files |
