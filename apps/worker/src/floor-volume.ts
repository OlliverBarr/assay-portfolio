/**
 * Read-only counterfactual delivery-volume report: answers "what would score
 * floor F deliver per day" on the correct population, `token_score_results`
 * (one row per live scoring pass, carrying the logged eligible / alertLevel /
 * score). The labeled `token_performance` winner-study set structurally
 * under-predicts live volume and must never be used for this question; see
 * docs/scoring-model.md "Delivery score floor" and the 2026-07-21 entry in
 * docs/decisions.md.
 *
 * The metric is a proxy: distinct qualifying tokens per UTC day, before
 * cooldown dedup, so it slightly over-counts versus what delivery would send
 * (a first-crossing-per-token count is a possible refinement). Live
 * `alerts_sent WHERE delivered` remains ground truth for the *current* floor;
 * this tool exists for *counterfactual* floors. No scorer replay happens
 * here: rows are read exactly as the live system logged them.
 *
 * After a model redeploy, always pass `--burst-discard-until=<deploy
 * instant>` to drop the post-deploy re-score burst, and never decide a floor
 * off less than 24h of burst-free data (hard rules in scoring-model.md).
 *
 *   bun run floor:volume -- --days=7 --floors=80,85,90
 *   bun run floor:volume -- --since=2026-07-14T00:00:00Z --burst-discard-until=2026-07-21T00:45:00Z
 *
 * Sends and mutates nothing, gates nothing: never feeds eligibility,
 * scoring, or alert delivery.
 */
import { loadChainConfigFromEnv } from "@assay/chain";
import { createDatabase, listTokenScoreResultsSince } from "@assay/database";

import { assertKnownFlags, readFlag } from "./cli-flags.js";
import {
  loadDatabaseUrlFromEnv,
  loadWorkerTuningFromEnv,
  WorkerConfigError
} from "./config.js";
import { createLogger, type Logger } from "./log.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Pure report builder (never touches env or a database)
// ---------------------------------------------------------------------------

/** The score-result fields the report reads; a narrowing of TokenScoreResultRow. */
export interface ScoreResultLike {
  readonly tokenAddress: string;
  readonly scoredAt: Date;
  readonly eligible: boolean;
  readonly score: number;
  readonly alertLevel: string;
}

export interface FloorVolumeOptions {
  /** Candidate delivery floors to evaluate. */
  readonly floors: readonly number[];
  /** RED-level additional floor; effective RED floor is max(floor, floorRed). */
  readonly floorRed: number;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  /** Rows scored before this instant are discarded (post-deploy re-score burst). */
  readonly burstDiscardUntil?: Date | undefined;
}

export interface FloorVolumeDay {
  /** UTC day, YYYY-MM-DD. */
  readonly day: string;
  /** Distinct tokens with at least one qualifying score row that day. */
  readonly tokens: number;
}

export interface FloorVolumeEntry {
  readonly floor: number;
  readonly perDay: readonly FloorVolumeDay[];
  /** Sum of per-day distinct token counts (token-days) over the window. */
  readonly totalTokenDays: number;
  /** totalTokenDays / windowDays: the deliveries-per-day proxy. */
  readonly tokensPerDay: number;
}

export interface FloorVolumeReport {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly windowDays: number;
  readonly rowsTotal: number;
  readonly rowsDiscardedAsBurst: number;
  readonly floors: readonly FloorVolumeEntry[];
}

/**
 * Delivery-qualifying predicate, identical to calibrate-sweep.ts's isCaught
 * effective-floor rule (and delivery's own): eligible, non-GRAY, and score
 * at or above the floor, where RED rows face max(floor, floorRed).
 */
function qualifies(row: ScoreResultLike, floor: number, floorRed: number): boolean {
  if (!row.eligible || row.alertLevel === "GRAY") return false;
  const effectiveFloor = row.alertLevel === "RED" ? Math.max(floor, floorRed) : floor;
  return row.score >= effectiveFloor;
}

export function buildFloorVolumeReport(
  rows: readonly ScoreResultLike[],
  options: FloorVolumeOptions
): FloorVolumeReport {
  const kept =
    options.burstDiscardUntil === undefined
      ? rows
      : rows.filter((row) => row.scoredAt >= options.burstDiscardUntil!);

  const windowDays = Math.max(
    (options.windowEnd.getTime() - options.windowStart.getTime()) / DAY_MS,
    Number.EPSILON
  );

  const floors = options.floors.map((floor): FloorVolumeEntry => {
    const tokensByDay = new Map<string, Set<string>>();
    for (const row of kept) {
      if (!qualifies(row, floor, options.floorRed)) continue;
      // UTC calendar day, YYYY-MM-DD.
      const day = row.scoredAt.toISOString().slice(0, 10);
      let tokens = tokensByDay.get(day);
      if (tokens === undefined) {
        tokens = new Set<string>();
        tokensByDay.set(day, tokens);
      }
      tokens.add(row.tokenAddress);
    }
    const perDay = [...tokensByDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, tokens]): FloorVolumeDay => ({ day, tokens: tokens.size }));
    const totalTokenDays = perDay.reduce((sum, entry) => sum + entry.tokens, 0);
    return {
      floor,
      perDay,
      totalTokenDays,
      tokensPerDay: totalTokenDays / windowDays
    };
  });

  return {
    windowStart: options.windowStart,
    windowEnd: options.windowEnd,
    windowDays,
    rowsTotal: rows.length,
    rowsDiscardedAsBurst: rows.length - kept.length,
    floors
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VALUE_FLAGS = ["since", "days", "floors", "burst-discard-until"] as const;
const BOOLEAN_FLAGS = ["help"] as const;

interface CliArgs {
  readonly help: boolean;
  readonly since: Date | undefined;
  readonly days: number;
  readonly floors: readonly number[] | undefined;
  readonly burstDiscardUntil: Date | undefined;
}

/** Parses floor:volume's CLI flags. Never touches the environment or a database. */
function parseCliArgs(argv: readonly string[]): CliArgs {
  assertKnownFlags(argv, VALUE_FLAGS, BOOLEAN_FLAGS);
  const help = argv.includes("--help");

  const daysRaw = readFlag(argv, "days");
  const days = daysRaw === undefined ? DEFAULT_WINDOW_DAYS : Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    throw new WorkerConfigError("--days", `must be a positive number, got "${daysRaw}"`);
  }

  const sinceRaw = readFlag(argv, "since");
  const since = sinceRaw === undefined ? undefined : new Date(sinceRaw);
  if (since !== undefined && Number.isNaN(since.getTime())) {
    throw new WorkerConfigError("--since", `must be an ISO date, got "${sinceRaw}"`);
  }

  const floorsRaw = readFlag(argv, "floors");
  let floors: readonly number[] | undefined;
  if (floorsRaw !== undefined) {
    floors = floorsRaw.split(",").map((part) => Number(part.trim()));
    if (floors.length === 0 || floors.some((floor) => !Number.isFinite(floor) || floor < 0)) {
      throw new WorkerConfigError(
        "--floors",
        `must be a comma list of non-negative numbers, got "${floorsRaw}"`
      );
    }
  }

  const burstRaw = readFlag(argv, "burst-discard-until");
  const burstDiscardUntil = burstRaw === undefined ? undefined : new Date(burstRaw);
  if (burstDiscardUntil !== undefined && Number.isNaN(burstDiscardUntil.getTime())) {
    throw new WorkerConfigError(
      "--burst-discard-until",
      `must be an ISO date, got "${burstRaw}"`
    );
  }

  return { help, since, days, floors, burstDiscardUntil };
}

function logReport(logger: Logger, report: FloorVolumeReport): void {
  logger.info("floor_volume.window", {
    windowStart: report.windowStart.toISOString(),
    windowEnd: report.windowEnd.toISOString(),
    windowDays: Number(report.windowDays.toFixed(2)),
    rowsTotal: report.rowsTotal,
    rowsDiscardedAsBurst: report.rowsDiscardedAsBurst
  });
  for (const entry of report.floors) {
    for (const day of entry.perDay) {
      logger.info("floor_volume.day", {
        floor: entry.floor,
        day: day.day,
        tokens: day.tokens
      });
    }
    logger.info("floor_volume.floor", {
      floor: entry.floor,
      totalTokenDays: entry.totalTokenDays,
      tokensPerDay: Number(entry.tokensPerDay.toFixed(2))
    });
  }
}

async function main(): Promise<void> {
  const logger = createLogger();
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    logger.info("floor_volume.usage", {
      usage:
        "bun run floor:volume -- [--days=7] [--since=<iso>] [--floors=80,85,90] [--burst-discard-until=<iso>]",
      notes:
        "Counterfactual deliveries/day per candidate floor from token_score_results. Distinct qualifying tokens per UTC day, before cooldown dedup. Default floors sweep [floor, floor+5, floor+10] from live tuning."
    });
    return;
  }

  const env = process.env;
  const chainConfig = loadChainConfigFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);
  const tuning = loadWorkerTuningFromEnv(env);

  const liveFloor = tuning.alertMinScore;
  const floors = args.floors ?? [liveFloor, liveFloor + 5, liveFloor + 10];
  const windowEnd = new Date();
  const windowStart = args.since ?? new Date(windowEnd.getTime() - args.days * DAY_MS);

  const handle = createDatabase(databaseUrl);
  try {
    await handle.applyMigrations();
    const rows = await listTokenScoreResultsSince(
      handle.db,
      chainConfig.chainId,
      windowStart
    );
    const report = buildFloorVolumeReport(rows, {
      floors,
      floorRed: tuning.alertMinScoreRed,
      windowStart,
      windowEnd,
      burstDiscardUntil: args.burstDiscardUntil
    });
    logReport(logger, report);
  } finally {
    await handle.close();
  }
}

// Run only when executed directly, see feedback.ts; importing the pure
// report builder above must never open a database connection.
if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("floor_volume.crashed", { error });
    process.exit(1);
  });
}
