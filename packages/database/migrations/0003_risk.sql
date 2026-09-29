CREATE TABLE IF NOT EXISTS "token_risks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"block_number" bigint NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"verification_status" text NOT NULL,
	"is_proxy" boolean,
	"implementation_address" text,
	"permission_findings" jsonb NOT NULL,
	"simulation_status" text NOT NULL,
	"effective_buy_loss_bps" integer,
	"effective_sell_loss_bps" integer,
	"risk_reasons" jsonb NOT NULL,
	"positive_reasons" jsonb NOT NULL,
	"null_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade_simulations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"block_number" bigint NOT NULL,
	"simulated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route" text NOT NULL,
	"buy_status" text NOT NULL,
	"transfer_status" text NOT NULL,
	"sell_status" text NOT NULL,
	"buy_quote_in_raw" numeric(78, 0),
	"buy_base_out_raw" numeric(78, 0),
	"spot_base_out_raw" numeric(78, 0),
	"sell_base_in_raw" numeric(78, 0),
	"sell_quote_out_raw" numeric(78, 0),
	"spot_quote_out_raw" numeric(78, 0),
	"effective_buy_loss_bps" integer,
	"effective_sell_loss_bps" integer,
	"revert_reason" text,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_risks_token_idx" ON "token_risks" USING btree ("chain_id","token_address","assessed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_risks_pool_idx" ON "token_risks" USING btree ("chain_id","pool_address","assessed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_simulations_token_idx" ON "trade_simulations" USING btree ("chain_id","token_address","simulated_at");
