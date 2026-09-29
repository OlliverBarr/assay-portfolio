CREATE TABLE IF NOT EXISTS "operator_decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"size_usd" numeric(60, 18),
	"price_usd" numeric(60, 18),
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operator_decisions_token_idx" ON "operator_decisions" USING btree ("chain_id","token_address","recorded_at");
