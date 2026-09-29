CREATE TABLE IF NOT EXISTS "activity_cursor" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"latest_observed_block" bigint NOT NULL,
	"latest_processed_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pool_swap_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"pool_address" text NOT NULL,
	"factory_kind" text NOT NULL,
	"block_number" bigint NOT NULL,
	"transaction_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"sender" text NOT NULL,
	"recipient" text NOT NULL,
	"token0_amount_raw" numeric(78, 0) NOT NULL,
	"token1_amount_raw" numeric(78, 0) NOT NULL,
	"base_amount_raw" numeric(78, 0) NOT NULL,
	"quote_amount_raw" numeric(78, 0) NOT NULL,
	"side" text NOT NULL,
	"quote_token_address" text NOT NULL,
	"base_token_address" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pool_activity_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"pool_address" text NOT NULL,
	"block_number" bigint NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unique_buyers_20m" integer NOT NULL,
	"unique_buyers_1h" integer NOT NULL,
	"buy_count_20m" integer NOT NULL,
	"sell_count_20m" integer NOT NULL,
	"quote_buy_volume_raw_20m" numeric(78, 0) NOT NULL,
	"quote_sell_volume_raw_20m" numeric(78, 0) NOT NULL,
	"quote_buy_volume_raw_1h" numeric(78, 0) NOT NULL,
	"quote_sell_volume_raw_1h" numeric(78, 0) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pool_swap_events_log_uid" ON "pool_swap_events" USING btree ("chain_id","transaction_hash","log_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_swap_events_pool_observed_idx" ON "pool_swap_events" USING btree ("chain_id","pool_address","observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_activity_snapshots_pool_idx" ON "pool_activity_snapshots" USING btree ("chain_id","pool_address","captured_at");
