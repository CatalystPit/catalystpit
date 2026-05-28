CREATE TABLE "congress_ticker_prices" (
	"ticker" text PRIMARY KEY NOT NULL,
	"current_price" double precision,
	"as_of_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "congress_trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"tx_hash" text NOT NULL,
	"chamber" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"representative" text,
	"member_slug" text,
	"party" text,
	"state" text,
	"district" text,
	"ticker" text,
	"asset_description" text,
	"asset_type" text,
	"owner" text,
	"type" text,
	"action" text NOT NULL,
	"amount_range" text,
	"amount_min" double precision,
	"amount_max" double precision,
	"amount_mid" double precision,
	"transaction_date" date,
	"disclosure_date" date NOT NULL,
	"filing_lag_days" integer,
	"cap_gains_over_200" boolean,
	"comment" text,
	"link" text,
	"price_at_trade" double precision,
	"price_at_trade_date" date,
	"enriched_at" timestamp with time zone,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_congress_tx" ON "congress_trades" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "idx_congress_member" ON "congress_trades" USING btree ("member_slug");--> statement-breakpoint
CREATE INDEX "idx_congress_disclosure" ON "congress_trades" USING btree ("disclosure_date");--> statement-breakpoint
CREATE INDEX "idx_congress_ticker" ON "congress_trades" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "idx_congress_txn_date" ON "congress_trades" USING btree ("transaction_date");