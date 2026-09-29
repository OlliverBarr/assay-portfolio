CREATE TABLE IF NOT EXISTS "pool_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"pool_address" text NOT NULL,
	"block_number" bigint NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"calculation_method" text NOT NULL,
	"price_usd" numeric(60, 18),
	"estimated_fdv_usd" numeric(60, 18),
	"quote_liquidity_usd" numeric(60, 18),
	"total_liquidity_usd" numeric(60, 18),
	"anchor_pool_address" text,
	"null_reason" text
);
--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "symbol" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "decimals" integer;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "total_supply" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "metadata_status" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "metadata_block" bigint;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_snapshots_pool_idx" ON "pool_snapshots" USING btree ("chain_id","pool_address","captured_at");