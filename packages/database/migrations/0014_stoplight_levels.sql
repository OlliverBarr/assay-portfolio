-- Stoplight alert-level rename (2026-07-11): RED->GREEN, ORANGE->YELLOW,
-- YELLOW->RED (GRAY unchanged). Semantic-preserving relabel of the tier
-- vocabulary — every row still denotes the same tier it always did — so the
-- append-only history keeps one consistent vocabulary and level-rank
-- comparisons (alert escalation dedup, judgment level filters, retro
-- attribution) never see dual-meaning strings. Single-statement CASE per
-- table avoids update-ordering hazards.
UPDATE "token_score_results" SET "alert_level" = CASE "alert_level"
  WHEN 'RED' THEN 'GREEN'
  WHEN 'ORANGE' THEN 'YELLOW'
  WHEN 'YELLOW' THEN 'RED'
  ELSE "alert_level"
END WHERE "alert_level" IN ('RED', 'ORANGE', 'YELLOW');
--> statement-breakpoint
UPDATE "alerts_sent" SET "alert_level" = CASE "alert_level"
  WHEN 'RED' THEN 'GREEN'
  WHEN 'ORANGE' THEN 'YELLOW'
  WHEN 'YELLOW' THEN 'RED'
  ELSE "alert_level"
END WHERE "alert_level" IN ('RED', 'ORANGE', 'YELLOW');
