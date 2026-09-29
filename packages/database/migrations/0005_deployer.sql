ALTER TABLE "tokens" ADD COLUMN "deployer_address" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "deployer_status" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "deployer_checked_at" timestamp with time zone;
