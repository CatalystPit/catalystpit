-- DIVIDEND EVENTS — one row per announced or historical dividend, in OUR vocabulary.
--
-- PROVIDER-NEUTRAL BY CONSTRUCTION. Not one column here is named after a vendor's field. The current
-- source is Polygon, which is a TEMPORARY DEVELOPMENT SOURCE; when the licensed feed is chosen, a
-- second adapter writes these same columns and nothing else in the product changes. That is the
-- whole point of the table existing rather than the API reading a vendor payload.
--
-- `dividend_type` is our enumeration ('regular' | 'special' | 'capital_gain' | 'liquidation' |
-- 'unknown'), never a vendor's two-letter code. `frequency` is payments per year as an integer,
-- because that is a fact about the dividend rather than a label someone chose.
--
-- IDEMPOTENT INGESTION rests on (source, source_event_id): a provider that revises an announced
-- dividend re-sends the same event id with new numbers, and that must UPDATE the row rather than
-- add a second one. A calendar showing a stale amount beside its correction is worse than either.
--
-- `announced` is what keeps a prediction from ever reaching a reader. It is set only when the source
-- carries a declaration date on or before the day we ingest it — an actual announcement by the
-- issuer. Nothing in this system infers a future dividend from a historical pattern, and a company
-- that has paid quarterly for thirty years has no row here for next quarter until it says so.

create table if not exists dividend_events (
  id                bigserial     primary key,

  -- provenance
  source            text          not null,          -- adapter id, e.g. 'polygon'
  source_event_id   text          not null,          -- the provider's stable id for this event

  -- identity
  ticker            text          not null,
  cik               text,                            -- when the source supplies one; not all do

  -- the four dates. Every one is nullable because a real feed omits them, and a missing date must
  -- render as "—" rather than being guessed from the others.
  declaration_date  date,
  ex_dividend_date  date,
  record_date       date,
  payment_date      date,

  -- the money
  cash_amount       double precision,
  currency          text,
  dividend_type     text,                            -- our enum, not the vendor's
  frequency         integer,                         -- payments per year: 0,1,2,4,12, or null
  annualized_amount double precision,                -- cash_amount * frequency, only when both known

  -- CONFIRMED, not predicted. See the note above.
  announced         boolean       not null default false,

  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),

  constraint uq_dividend_source_event unique (source, source_event_id)
);

-- The calendar's primary axis: a date range on the ex-dividend date.
create index if not exists idx_dividend_ex_date on dividend_events (ex_dividend_date);
-- The same question asked of the payment date, which the API can already answer and the UI will.
create index if not exists idx_dividend_pay_date on dividend_events (payment_date);
-- A single ticker's dividend history, newest first — the ticker page's question.
create index if not exists idx_dividend_ticker_ex on dividend_events (ticker, ex_dividend_date desc);

-- The calendar reads ANNOUNCED events in a date window, so the index it actually uses covers both.
-- Partial, because unannounced rows are never on the calendar and do not belong in this index.
create index if not exists idx_dividend_announced_ex
  on dividend_events (ex_dividend_date, ticker) where announced;
create index if not exists idx_dividend_announced_pay
  on dividend_events (payment_date, ticker) where announced;

comment on table dividend_events is
  'Canonical dividend events, provider-neutral. Written only by scheduled ingestion, never on a user request. TEMPORARY SOURCE: Polygon. Production redistribution rights must be confirmed or the provider replaced before public commercial launch.';
