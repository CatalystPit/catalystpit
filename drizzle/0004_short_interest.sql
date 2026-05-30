CREATE TABLE "short_interest" (
	"settlement_date" date NOT NULL,
	"ticker" text NOT NULL,
	"short_int_shares" double precision,
	"prev_short_int_shares" double precision,
	"avg_daily_volume" double precision,
	"days_to_cover" double precision,
	"change_percent" double precision,
	"market_center" text,
	"issue_name" text,
	"source" text DEFAULT 'finra' NOT NULL,
	CONSTRAINT "short_interest_settlement_date_ticker_pk" PRIMARY KEY("settlement_date","ticker")
);
--> statement-breakpoint
CREATE INDEX "idx_short_interest_ticker" ON "short_interest" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "idx_short_interest_settlement" ON "short_interest" USING btree ("settlement_date");