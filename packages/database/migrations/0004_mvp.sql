CREATE TABLE IF NOT EXISTS "token_holders" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"holder_address" text NOT NULL,
	"balance_raw" numeric(78, 0) NOT NULL,
	"updated_block" bigint NOT NULL,
	CONSTRAINT "token_holders_chain_id_token_address_holder_address_pk" PRIMARY KEY("chain_id","token_address","holder_address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_holder_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"block_number" bigint NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"holder_count" integer NOT NULL,
	"adjusted_holder_count" integer NOT NULL,
	"largest_holder_pct_bps" integer NOT NULL,
	"top10_pct_bps" integer NOT NULL,
	"adjusted_top10_pct_bps" integer NOT NULL,
	"deployer_pct_bps" integer,
	"holder_cluster_score_bps" integer,
	"excluded" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_eligibility_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"block_number" bigint NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"eligible" boolean NOT NULL,
	"failed_rules" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"features" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_score_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"block_number" bigint NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"eligible" boolean NOT NULL,
	"score" integer NOT NULL,
	"components" jsonb NOT NULL,
	"alert_level" text NOT NULL,
	"positive_reasons" jsonb NOT NULL,
	"risk_reasons" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alerts_sent" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"alert_level" text NOT NULL,
	"score" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"transport" text NOT NULL,
	"delivered" boolean NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_holder_snapshots_token_idx" ON "token_holder_snapshots" USING btree ("chain_id","token_address","captured_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_eligibility_results_token_idx" ON "token_eligibility_results" USING btree ("chain_id","token_address","evaluated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_score_results_token_idx" ON "token_score_results" USING btree ("chain_id","token_address","scored_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_sent_token_idx" ON "alerts_sent" USING btree ("chain_id","token_address","sent_at");
