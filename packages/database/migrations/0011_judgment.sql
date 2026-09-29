CREATE TABLE IF NOT EXISTS "prompt_registry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"template_hash" text NOT NULL,
	"template" text NOT NULL,
	"changelog" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_registry_name_version_uid" ON "prompt_registry" USING btree ("name","version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "judgment_briefs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"mode" text NOT NULL,
	"alert_id" bigint,
	"eval_run_id" bigint,
	"as_of" timestamp with time zone NOT NULL,
	"prompt_name" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"template_hash" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"thesis" text,
	"confidence_bps" integer,
	"recommendation" text,
	"risk_calls" jsonb,
	"disconfirming" jsonb,
	"what_would_change" jsonb,
	"citations_total" integer,
	"citations_verified" integer,
	"delivery" text,
	"cost_usd" numeric(20, 8),
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "judgment_briefs_alert_uid" ON "judgment_briefs" USING btree ("alert_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "judgment_briefs_token_idx" ON "judgment_briefs" USING btree ("chain_id","token_address","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "judgment_briefs_eval_run_idx" ON "judgment_briefs" USING btree ("eval_run_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "judgment_tool_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"brief_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"result_row_ids" jsonb,
	"result_digest" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "judgment_tool_calls_brief_seq_uid" ON "judgment_tool_calls" USING btree ("brief_id","seq");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "judgment_citations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"brief_id" bigint NOT NULL,
	"claim_key" text NOT NULL,
	"cited_table" text NOT NULL,
	"cited_row_id" bigint NOT NULL,
	"cited_field" text NOT NULL,
	"claimed_value" text NOT NULL,
	"verified" boolean NOT NULL,
	"actual_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "judgment_citations_brief_idx" ON "judgment_citations" USING btree ("brief_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "judgment_eval_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"prompt_name" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"horizon_hours" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"briefs_total" integer NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "judgment_eval_runs_prompt_idx" ON "judgment_eval_runs" USING btree ("prompt_name","prompt_version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "judgment_eval_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"brief_id" bigint NOT NULL,
	"pool_address" text NOT NULL,
	"realized_label" text NOT NULL,
	"realized_max_multiple_bps" integer NOT NULL,
	"predicted_hit_bps" integer NOT NULL,
	"realized_hit" boolean NOT NULL,
	"brier_micro" integer NOT NULL,
	"risk_matches" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "judgment_eval_items_run_brief_uid" ON "judgment_eval_items" USING btree ("run_id","brief_id");
