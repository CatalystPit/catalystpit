CREATE TABLE "insider_trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"company" text,
	"executive" text,
	"title" text,
	"transaction_code" text,
	"action" text NOT NULL,
	"shares" double precision DEFAULT 0 NOT NULL,
	"price_per_share" double precision DEFAULT 0 NOT NULL,
	"total_value" double precision DEFAULT 0 NOT NULL,
	"shares_owned_after" double precision,
	"security_title" text,
	"transaction_date" date,
	"filing_date" date NOT NULL,
	"accession" text NOT NULL,
	"filing_url" text,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_insider_txn" ON "insider_trades" USING btree ("accession","transaction_date","transaction_code","security_title","shares","price_per_share","shares_owned_after");--> statement-breakpoint
CREATE INDEX "idx_insider_ticker" ON "insider_trades" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "idx_insider_filing_date" ON "insider_trades" USING btree ("filing_date");--> statement-breakpoint
CREATE INDEX "idx_insider_ticker_filing" ON "insider_trades" USING btree ("ticker","filing_date");--> statement-breakpoint
CREATE INDEX "idx_insider_transaction_date" ON "insider_trades" USING btree ("transaction_date");