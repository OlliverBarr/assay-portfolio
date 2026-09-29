CREATE TABLE IF NOT EXISTS "telegram_subscriptions" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"title" text,
	"status" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_cursor" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_update_id" bigint NOT NULL
);
