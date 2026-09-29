CREATE INDEX IF NOT EXISTS "pool_activity_snapshots_time_idx" ON "pool_activity_snapshots" USING btree ("chain_id","captured_at");
