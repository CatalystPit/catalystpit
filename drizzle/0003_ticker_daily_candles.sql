CREATE TABLE "ticker_daily_candles" (
	"ticker" text NOT NULL,
	"date" date NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" double precision DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'tiingo' NOT NULL,
	CONSTRAINT "ticker_daily_candles_ticker_date_pk" PRIMARY KEY("ticker","date")
);
