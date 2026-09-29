CREATE TABLE IF NOT EXISTS "chain_cursor" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"latest_observed_block" bigint NOT NULL,
	"latest_processed_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pools" (
	"chain_id" integer NOT NULL,
	"pool_address" text NOT NULL,
	"factory_address" text NOT NULL,
	"dex" text NOT NULL,
	"factory_kind" text NOT NULL,
	"token0_address" text NOT NULL,
	"token1_address" text NOT NULL,
	"fee_ppm" integer,
	"tick_spacing" integer,
	"quote_token_address" text,
	"base_token_address" text,
	"created_at_block" bigint NOT NULL,
	"created_tx_hash" text NOT NULL,
	"created_log_index" integer NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pools_chain_id_pool_address_pk" PRIMARY KEY("chain_id","pool_address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quote_assets" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"verification_source" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_assets_chain_id_address_pk" PRIMARY KEY("chain_id","address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tokens" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"first_seen_block" bigint NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_chain_id_address_pk" PRIMARY KEY("chain_id","address")
);
