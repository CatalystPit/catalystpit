# Definition of Done

A feature is not done because it renders. Every item below exists because skipping it has already
cost us a repair. Short on purpose — a checklist nobody reads protects nothing.

## 1. Correctness

- [ ] The result is checked against a source that owes nothing to our own pipeline — the filer's own
      cover page, SEC's index, the vendor's declared total. Our logs cannot confirm our own output.
- [ ] Impossible values are rejected, not rendered: non-finite numbers, negative counts, dates before
      the period they describe.
- [ ] **"No error was recorded" is never treated as "it worked."** A job reports `complete`,
      `partial` or `failed`, and a completion marker is written only for `complete`.

## 2. Identity

- [ ] Anything shown as a ticker passes `isRenderableTicker()`. No placeholders, no raw CUSIPs, no
      company names promoted to symbols.
- [ ] A ticker-facing surface with an unresolvable candidate **skips to the next valid one** rather
      than blanking the symbol and keeping the row.
- [ ] Sector and industry come from `market-taxonomy.mjs`. No parallel classification, no
      per-ticker overrides as the primary mechanism, nothing inferred from a company name.
- [ ] Lower-authority data cannot overwrite higher-authority data (`shouldReplaceIdentity()`).

## 3. States

- [ ] Loading, empty and error states are designed and distinguishable. **An accidental blank is not
      an empty state**, and a failed query must not render as "no results".
- [ ] One bad record does not take down the page.
- [ ] Failures surface a real status code. Not `200` with an empty array.

## 4. Performance

- [ ] Measured with `scripts/perf-baseline.mjs` before and after — cold and warm separately.
- [ ] Cache lifetime matches how often the data actually changes. `no-store` on data that is
      identical for every viewer is a bug; caching per-viewer data is a worse one.
- [ ] No unbounded query, no per-request full-table aggregate, no N+1.
- [ ] A new index corresponds to a real access pattern, and its write cost was considered.

## 5. Freshness & health

- [ ] The dataset appears in `/api/health` with a freshness threshold matching its real cadence.
- [ ] Completeness is reported **separately from** freshness — a dataset can be fresh and wrong.

## 6. Regression protection

- [ ] The specific defect has a test that fails without the fix.
- [ ] Assertions are **mutation-tested**: break the implementation deliberately and confirm the suite
      notices. An assertion no mutation can break is decoration.
- [ ] A test that crashes under mutation is made null-safe first — a crash reads as a broken test
      rather than a caught defect.
- [ ] Fixtures key on the underlying data (SIC codes, accessions), not on answers memorised per
      ticker.

## 7. Before deploy

- [ ] `npm run build` compiles.
- [ ] Verified in **production**, not just locally — the homepage `NONE` fix looked complete in code
      and was still leaking into two other modules on the live page.
- [ ] Licensing-sensitive behaviour (realtime vs delayed) is correct, and any assumption that will
      expire is written down at the point it will break.

---

### The rule behind the list

When something breaks: identify the failure **class**, fix the root cause, protect the boundary, add
regression coverage, move on. Do not fix the symptom, and do not turn a bug into a three-day
architecture project.
