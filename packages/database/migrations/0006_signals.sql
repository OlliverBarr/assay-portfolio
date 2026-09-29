ALTER TABLE "pool_activity_snapshots" ADD COLUMN "buy_size_gini_bps" integer;--> statement-breakpoint
ALTER TABLE "pool_activity_snapshots" ADD COLUMN "buy_size_entropy_bps" integer;--> statement-breakpoint
ALTER TABLE "pool_activity_snapshots" ADD COLUMN "repeated_size_buy_pct_bps" integer;--> statement-breakpoint
ALTER TABLE "token_holder_snapshots" ADD COLUMN "float_bps" integer;--> statement-breakpoint
ALTER TABLE "token_holder_snapshots" ADD COLUMN "supply_in_pool_bps" integer;--> statement-breakpoint
ALTER TABLE "trade_simulations" ADD COLUMN "slippage_curve" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_outcomes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"horizon_hours" integer NOT NULL,
	"outcome" text NOT NULL,
	"peak_quote_liquidity_usd" numeric(60, 18),
	"quote_liquidity_at_horizon_usd" numeric(60, 18),
	"estimated_fdv_at_horizon_usd" numeric(60, 18),
	"first_observed_at" timestamp with time zone NOT NULL,
	"labeled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "token_outcomes_pool_horizon_uid" ON "token_outcomes" USING btree ("chain_id","pool_address","horizon_hours");
