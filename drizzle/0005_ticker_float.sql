CREATE TABLE "ticker_float" (
	"ticker" text PRIMARY KEY NOT NULL,
	"float_shares" double precision,
	"outstanding_shares" double precision,
	"free_float_pct" double precision,
	"source" text DEFAULT 'fmp' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
