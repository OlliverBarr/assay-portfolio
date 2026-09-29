/**
 * Read-only winners-retro deep-dive: prints recorded winner-retro items
 * (qualifying winners by default), running coverage-tier totals, and the
 * tier-2 census. The weekly-ritual companion to the event-driven digest —
 * pool at least a week before treating any tier pattern as signal (see
 * docs/execution-methodology.md). Sends nothing, mutates nothing.
 *
 *   bun run retro:winners
 *   bun run retro:winners -- --since-days=14 --all
 */
import { loadChainConfigFromEnv } from "@assay/chain";
import {
  countUntrustedPoolsCreatedSince,
  createDatabase,
  listWinnerRetroItems,
  type WinnerRetroItemRow
} from "@assay/database";

import { loadDatabaseUrlFromEnv, loadWorkerTuningFromEnv } from "./config.js";
import { createLogger } from "./log.js";
import { TIER_LABELS } from "./winners-retro.js";

function parseSinceDays(argv: readonly string[]): number {
  const arg = argv.find((value) => value.startsWith("--since-days="));
  if (arg === undefined) return 7;
  const days = Number(arg.slice("--since-days=".length));
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--since-days must be a positive number, got "${arg}"`);
  }
  return days;
}

/** Same qualifying bars the digest applies (sustained multiple + exit liquidity). */
function isQualifying(
  row: WinnerRetroItemRow,
  minMultipleBps: number,
  minExitLiquidityUsd: number
): boolean {
  if (row.sustainedMultipleBps < minMultipleBps) return false;
  if (row.exitQuoteLiquidityUsd === null) return false;
  const exitLiquidity = Number(row.exitQuoteLiquidityUsd);
  return Number.isFinite(exitLiquidity) && exitLiquidity >= minExitLiquidityUsd;
}

async function main(): Promise<void> {
  const logger = createLogger();
  const env = process.env;
  const config = loadChainConfigFromEnv(env);
  const tuning = loadWorkerTuningFromEnv(env);
  const sinceDays = parseSinceDays(process.argv.slice(2));
  const includeAll = process.argv.includes("--all");
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const handle = createDatabase(loadDatabaseUrlFromEnv(env));
  try {
    const rows = await listWinnerRetroItems(handle.db, config.chainId, { since });
    const qualifying = rows.filter((row) =>
      isQualifying(row, tuning.winnersMinMultipleBps, tuning.winnersMinExitLiquidityUsd)
    );
    const shown = includeAll ? rows : qualifying;

    const tierTotals = new Map<number, number>();
    for (const row of qualifying) {
      tierTotals.set(row.coverageTier, (tierTotals.get(row.coverageTier) ?? 0) + 1);
    }
    const untrusted = await countUntrustedPoolsCreatedSince(
      handle.db,
      config.chainId,
      since
    );

    logger.info("retro_winners.report", {
      sinceDays,
      evaluated: rows.length,
      qualifying: qualifying.length,
      untrustedPoolsSince: untrusted,
      tierTotals: Object.fromEntries(
        [...tierTotals.entries()]
          .sort(([a], [b]) => a - b)
          .map(([tier, total]) => [`T${tier} ${TIER_LABELS[tier] ?? "?"}`, total])
      )
    });
    for (const row of shown) {
      logger.info("retro_winners.item", {
        token: row.tokenAddress,
        pool: row.poolAddress,
        horizonHours: row.horizonHours,
        enteredAt: row.entryAt.toISOString(),
        sustainedX: row.sustainedMultipleBps / 10_000,
        wickX: row.wickMultipleBps / 10_000,
        exitQuoteLiquidityUsd: row.exitQuoteLiquidityUsd,
        tier: `T${row.coverageTier} ${row.tierLabel}`,
        alerted: row.alerted,
        provisional: row.provisional,
        qualifying: isQualifying(
          row,
          tuning.winnersMinMultipleBps,
          tuning.winnersMinExitLiquidityUsd
        ),
        gateAttribution: row.gateAttribution
      });
    }
  } finally {
    await handle.close();
  }
}

// Guarded so test imports never open a database connection; `import.meta.main`
// is Bun's direct-run flag, absent under vitest's Node runtime.
if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("retro_winners.crashed", { error });
    process.exit(1);
  });
}
