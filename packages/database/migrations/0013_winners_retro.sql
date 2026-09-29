CREATE TABLE IF NOT EXISTS "winner_retro_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"horizon_hours" integer NOT NULL,
	"entry_at" timestamp with time zone NOT NULL,
	"entry_fdv_usd" numeric(60, 18) NOT NULL,
	"wick_multiple_bps" integer NOT NULL,
	"sustained_multiple_bps" integer NOT NULL,
	"exit_quote_liquidity_usd" numeric(60, 18),
	"minutes_to_sustained_peak" integer,
	"provisional" boolean NOT NULL,
	"coverage_tier" integer NOT NULL,
	"tier_label" text NOT NULL,
	"alerted" boolean NOT NULL,
	"gate_attribution" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "winner_retro_items_pool_horizon_uid" ON "winner_retro_items" USING btree ("chain_id","pool_address","horizon_hours");
