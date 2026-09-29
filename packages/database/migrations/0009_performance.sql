CREATE TABLE IF NOT EXISTS "token_performance" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"horizon_hours" integer NOT NULL,
	"band_min_fdv_usd" numeric(60, 18) NOT NULL,
	"band_max_fdv_usd" numeric(60, 18) NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"entry_block" bigint NOT NULL,
	"entry_price_usd" numeric(60, 18) NOT NULL,
	"entry_fdv_usd" numeric(60, 18) NOT NULL,
	"max_multiple_bps" integer NOT NULL,
	"max_drawdown_bps" integer NOT NULL,
	"minutes_to_peak" integer NOT NULL,
	"snapshots_in_window" integer NOT NULL,
	"entry_features" jsonb NOT NULL,
	"labeled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "token_performance_pool_horizon_uid" ON "token_performance" USING btree ("chain_id","pool_address","horizon_hours");
