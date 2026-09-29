import { runActivityPass } from "@assay/activity";
import {
  createChainPublicClient,
  createRpcLogSource,
  findBlockNumberByTimestamp,
  loadChainConfigFromEnv,
  withRetry
} from "@assay/chain";
import { createDryRunTransport, createTelegramTransport, type AlertTransport } from "@assay/alerts";
import {
  createDatabase,
  getOrCreatePrompt,
  renormalizeUntrustedPools,
  upsertQuoteAssets,
  upsertTelegramSubscription,
  type ActivePoolCriteria,
  type FdvBandCriteria
} from "@assay/database";
import { runDiscoveryPass } from "@assay/discovery";
import {
  EnrichmentHaltError,
  runEnrichmentPass,
  type EnrichmentPassResult
} from "@assay/enrichment";
import { createHolderReader, runHolderPass } from "@assay/holders";
import {
  BRIEF_PROMPT_V1_CHANGELOG,
  briefPromptSpecV1,
  createOpenAiCompatibleLlmClient
} from "@assay/judgment";
import {
  createQuoteRouteSimulator,
  createRiskReader,
  runRiskPass,
  type RouteSimulator
} from "@assay/risk-engine";
import {
  alertThresholdsFromTuning,
  eligibilityConfigFromTuning,
  loadDatabaseUrlFromEnv,
  loadJudgmentConfigFromEnv,
  loadRiskSimulatorConfigFromEnv,
  loadTelegramConfigFromEnv,
  loadWorkerTuningFromEnv
} from "./config.js";
import { createLogger } from "./log.js";
import {
  ActiveSetCutoffError,
  runActivityLoop,
  runDiscoveryLoop,
  runHolderLoop,
  runJudgmentLoop,
  runOutcomeLoop,
  runPerformanceLoop,
  runPollLoop,
  runRiskLoop,
  runScoringLoop,
  runSubscriptionsLoop,
  runWinnersRetroLoop
} from "./loop.js";
import { createFanoutTransport } from "./fanout-transport.js";
import { runJudgmentPass } from "./judgment-pass.js";
import { runOutcomePass } from "./outcome-pass.js";
import { runPerformancePass } from "./performance-pass.js";
import { runWinnersRetroPass } from "./winners-retro-pass.js";
import { runScoringPass } from "./scoring-pass.js";
import {
  createTelegramUpdatesApi,
  runSubscriptionsPass
} from "./subscriptions-pass.js";
import { buildScorecard } from "./score-request.js";

const QUOTE_ASSET_VERIFICATION_SOURCE = "docs/data-sources.md";

async function main(): Promise<void> {
  const logger = createLogger();
  const env = process.env;

  // Any malformed configuration stops the worker before it touches state.
  const config = loadChainConfigFromEnv(env);
  const tuning = loadWorkerTuningFromEnv(env);
  const databaseUrl = loadDatabaseUrlFromEnv(env);

  const handle = createDatabase(databaseUrl);
  await handle.applyMigrations();
  await upsertQuoteAssets(
    handle.db,
    config.quoteAssets.map((asset) => ({
      chainId: config.chainId,
      address: asset.address,
      symbol: asset.symbol,
      decimals: asset.decimals,
      verificationSource: QUOTE_ASSET_VERIFICATION_SOURCE
    }))
  );
  // Backfill quote/base classification for pools discovered BEFORE an asset
  // joined the allow-list (2026-07-12: ~3.2k VIRTUAL-quoted pools). Config-
  // driven and idempotent — a future allow-list addition backfills on boot.
  const renormalized = await renormalizeUntrustedPools(
    handle.db,
    config.chainId,
    config.quoteAssets
  );

  const client = createChainPublicClient(config);
  const logSource = createRpcLogSource(client);
  const riskSimulatorConfig = loadRiskSimulatorConfigFromEnv(env);
  const riskSimulator: RouteSimulator | undefined =
    riskSimulatorConfig.v2Router === undefined &&
    riskSimulatorConfig.v3Quoter === undefined
      ? undefined
      : createQuoteRouteSimulator(client, riskSimulatorConfig);
  const explorerUrl = env["ROBINHOOD_CHAIN_EXPLORER_URL"]?.trim();
  const riskReader = createRiskReader(client, {
    ...(explorerUrl === undefined || explorerUrl === ""
      ? {}
      : { explorerUrl })
  });
  const holderReader = createHolderReader(client, {
    chunkSize: tuning.holdersScanChunkBlocks,
    ...(explorerUrl === undefined || explorerUrl === ""
      ? {}
      : { explorerUrl })
  });
  const judgmentConfig = loadJudgmentConfigFromEnv(env);
  const judgmentPromptTemplate = briefPromptSpecV1();
  // Prompt registration is a one-time startup write (idempotent on template
  // hash via getOrCreatePrompt), never repeated per pass. LLM client + real
  // transport is fan-out `alertTransport` — briefs never open a second
  // Telegram connection.
  const judgmentRuntime =
    judgmentConfig.llm === undefined
      ? undefined
      : {
          llm: createOpenAiCompatibleLlmClient({
            baseUrl: judgmentConfig.llm.baseUrl,
            apiKey: judgmentConfig.llm.apiKey
          }),
          model: judgmentConfig.llm.model,
          prompt: await getOrCreatePrompt(handle.db, {
            name: judgmentPromptTemplate.name,
            template: judgmentPromptTemplate.template,
            templateHash: judgmentPromptTemplate.templateHash,
            changelog: BRIEF_PROMPT_V1_CHANGELOG
          })
        };
  const telegram = loadTelegramConfigFromEnv(env);
  const joinCode = env["TELEGRAM_JOIN_CODE"]?.trim() || undefined;
  // Primary transport: static chat (or dry-run). Fan-out wraps it so every
  // ACTIVE self-service subscription also receives alerts, with per-chat
  // failure isolation and 403 -> auto-unsubscribe.
  const primaryTransport: AlertTransport =
    telegram === undefined
      ? createDryRunTransport((text) => {
          logger.info("alert.dry_run", { text });
        })
      : createTelegramTransport(telegram.botToken, telegram.chatId);
  const alertTransport: AlertTransport =
    telegram === undefined
      ? primaryTransport
      : createFanoutTransport({
          db: handle.db,
          primary: primaryTransport,
          sendToChat: (chatId, text) =>
            createTelegramTransport(telegram.botToken, chatId).send(text),
          staticChatId: telegram.chatId,
          onRemoved: async (chatId) => {
            await upsertTelegramSubscription(handle.db, {
              chatId,
              title: null,
              status: "REMOVED"
            });
            logger.info("subscriptions.auto_removed", { chatId });
          },
          logger
        });
  const alertTransportName = telegram === undefined ? "dry-run" : "telegram";

  logger.info("worker.started", {
    chainId: config.chainId,
    factories: config.factories.map((f) => `${f.kind}@${f.address}`),
    quoteAssets: config.quoteAssets.map((a) => `${a.symbol}@${a.address}`),
    poolsRenormalized: renormalized,
    pollIntervalMs: tuning.pollIntervalMs,
    chunkSize: tuning.chunkSize,
    activePoolMaxAgeHours: tuning.activePoolMaxAgeHours,
    watchFdvBandUsd: `${tuning.watchMinFdvUsd}-${tuning.watchMaxFdvUsd}`,
    enrichmentIdleRefreshMs: tuning.enrichmentIdleRefreshMs,
    confirmations: tuning.confirmations,
    enrichmentIntervalMs: tuning.enrichmentIntervalMs,
    enrichmentConcurrency: tuning.enrichmentConcurrency,
    activityIntervalMs: tuning.activityIntervalMs,
    activityChunkSize: tuning.activityChunkSize,
    activityConfirmations: tuning.activityConfirmations,
    riskIntervalMs: tuning.riskIntervalMs,
    riskSimulator: riskSimulator === undefined ? "disabled" : "enabled",
    holdersIntervalMs: tuning.holdersIntervalMs,
    holdersScanChunkBlocks: tuning.holdersScanChunkBlocks,
    bandLaneMinQuoteLiquidityUsd: tuning.bandLaneMinQuoteLiquidityUsd,
    scoringIntervalMs: tuning.scoringIntervalMs,
    outcomeIntervalMs: tuning.outcomeIntervalMs,
    outcomeHorizonsHours: tuning.outcomeHorizonsHours.join(","),
    performanceIntervalMs: tuning.performanceIntervalMs,
    performanceBandUsd: `${tuning.performanceBandMinFdvUsd}-${tuning.performanceBandMaxFdvUsd}`,
    judgmentEnabled: judgmentConfig.enabled,
    judgmentPollIntervalMs: judgmentConfig.pollIntervalMs,
    judgmentMinAlertLevel: judgmentConfig.minAlertLevel,
    alertTransport: alertTransportName
  });

  const controller = new AbortController();
  let signalCount = 0;
  const onSignal = (signal: string) => {
    signalCount += 1;
    if (signalCount > 1) {
      logger.error("worker.force_exit", { signal });
      process.exit(130);
    }
    logger.info("worker.stopping", { signal });
    controller.abort();
  };

  // Active-set youth is measured by ON-CHAIN creation block, never by
  // discovered_at: after a backfill or downtime catch-up, ingestion time
  // stamps the whole historical population as young (live incident
  // 2026-07-11: ~62k pools all active -> 65,534-bind-parameter crash loop).
  // The cutoff block is found by timestamp binary search and cached briefly;
  // drift within the cache window is immaterial against a multi-hour window.
  const CUTOFF_CACHE_MS = 5 * 60 * 1000;
  const earliestFactoryBlock = config.factories.reduce(
    (min, factory) =>
      factory.deploymentBlock < min ? factory.deploymentBlock : min,
    config.factories[0]?.deploymentBlock ?? 0n
  );
  let cachedCutoff: { block: bigint; computedAt: number } | undefined;
  const activeMinCreatedBlock = async (): Promise<bigint> => {
    const nowMs = Date.now();
    if (
      cachedCutoff !== undefined &&
      nowMs - cachedCutoff.computedAt < CUTOFF_CACHE_MS
    ) {
      return cachedCutoff.block;
    }
    // Classified so an RPC outage on this shared pre-pass read halts the
    // calling loop (enrichment/activity/risk/holders) instead of crashing
    // the worker (2026-07-21: exhausted RPC credits -> restart loop).
    try {
      const headBlock = await withRetry("getBlockNumber", () =>
        client.getBlockNumber()
      );
      const targetSeconds = BigInt(
        Math.floor(
          (nowMs - tuning.activePoolMaxAgeHours * 60 * 60 * 1000) / 1000
        )
      );
      const block = await findBlockNumberByTimestamp(client, targetSeconds, {
        minBlock: earliestFactoryBlock,
        headBlock
      });
      cachedCutoff = { block, computedAt: nowMs };
      return block;
    } catch (error) {
      throw new ActiveSetCutoffError("active-set cutoff read failed", {
        cause: error
      });
    }
  };
  // Fresh per pass: a stale `now` would silently shrink the active set.
  const activeCriteria = async (): Promise<ActivePoolCriteria> => ({
    now: new Date(),
    activeMinCreatedBlock: await activeMinCreatedBlock(),
    watchMinFdvUsd: tuning.watchMinFdvUsd,
    watchMaxFdvUsd: tuning.watchMaxFdvUsd
  });
  // Watch band for expensive-signal prioritization: holders/risk/scoring
  // serve pools valued inside this band first (2026-07-12 audit — global
  // staleness sweeps starved band tokens of ownership/sim data).
  const watchBand: FdvBandCriteria = {
    minFdvUsd: tuning.watchMinFdvUsd,
    maxFdvUsd: tuning.watchMaxFdvUsd
  };
  // Eligibility rules + alert tier bands, env-tunable alongside the watch
  // band; every caller of the scoring trio must receive these or it
  // silently diverges from the live pass under an env override.
  const eligibilityConfig = eligibilityConfigFromTuning(tuning);
  const alertThresholds = alertThresholdsFromTuning(tuning);
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const discoveryLoop = runDiscoveryLoop({
    runPass: () =>
      runDiscoveryPass({
        db: handle.db,
        logSource,
        config,
        chunkSize: tuning.chunkSize,
        confirmations: tuning.confirmations,
        signal: controller.signal
      }),
    pollIntervalMs: tuning.pollIntervalMs,
    signal: controller.signal,
    logger
  });

  const enrichmentLoop = runPollLoop<EnrichmentPassResult>({
    name: "enrichment",
    runOnce: async () =>
      runEnrichmentPass({
        db: handle.db,
        reader: client,
        config,
        signal: controller.signal,
        concurrency: tuning.enrichmentConcurrency,
        selection: {
          active: await activeCriteria(),
          idleRefreshMs: tuning.enrichmentIdleRefreshMs,
          idleBatchLimit: tuning.enrichmentIdleBatchLimit
        }
      }),
    describe: (result) => ({
      event: "enrichment.pass",
      fields: {
        chainId: result.chainId,
        blockNumber: result.blockNumber,
        poolsSelected: result.poolsSelected,
        activePools: result.activePools,
        idlePools: result.idlePools,
        snapshotsInserted: result.snapshotsInserted,
        metadataRefreshed: result.metadataRefreshed,
        poolErrors: result.poolErrors.length,
        anchorPoolAddress: result.anchorPoolAddress,
        stopped: result.stopped
      }
    }),
    isRecoverable: (error) =>
      error instanceof EnrichmentHaltError || error instanceof ActiveSetCutoffError
        ? { reason: error.message }
        : null,
    pollIntervalMs: tuning.enrichmentIntervalMs,
    signal: controller.signal,
    logger
  });

  const activityLoop = runActivityLoop({
    runPass: async () =>
      runActivityPass({
        db: handle.db,
        logSource,
        config,
        chunkSize: tuning.activityChunkSize,
        confirmations: tuning.activityConfirmations,
        // Active-set scoping: chunk cost scales with launch activity, not
        // the all-time pool count (2026-07-11 stall). Any alertable pool is
        // inside the watch band and therefore active by construction.
        active: await activeCriteria(),
        snapshotRefreshMs: tuning.activitySnapshotRefreshMs,
        refreshBatchLimit: tuning.activityRefreshBatchLimit,
        signal: controller.signal
      }),
    pollIntervalMs: tuning.activityIntervalMs,
    signal: controller.signal,
    logger
  });

  const riskLoop = runRiskLoop({
    runPass: async () =>
      runRiskPass({
        db: handle.db,
        reader: riskReader,
        config,
        thresholds: { maxSellLossBps: tuning.riskMaxSellLossBps },
        stalenessMs: tuning.riskStalenessMs,
        poolLimit: tuning.riskBatchLimit,
        // Band lane first; staleness backlog fills the remaining budget.
        band: watchBand,
        backlog: await activeCriteria(),
        bandMinQuoteLiquidityUsd: tuning.bandLaneMinQuoteLiquidityUsd,
        signal: controller.signal,
        ...(riskSimulator === undefined ? {} : { simulator: riskSimulator })
      }),
    pollIntervalMs: tuning.riskIntervalMs,
    signal: controller.signal,
    logger
  });

  const holderLoop = runHolderLoop({
    runPass: async () =>
      runHolderPass({
        db: handle.db,
        reader: holderReader,
        config,
        stalenessMs: tuning.holdersStalenessMs,
        selection: {
          band: watchBand,
          bandMinQuoteLiquidityUsd: tuning.bandLaneMinQuoteLiquidityUsd,
          bandLimit: tuning.holdersBandLimit,
          backlog: {
            minCreatedBlock: await activeMinCreatedBlock(),
            limit: tuning.holdersBacklogLimit
          }
        },
        signal: controller.signal
      }),
    pollIntervalMs: tuning.holdersIntervalMs,
    signal: controller.signal,
    logger
  });

  const scoringLoop = runScoringLoop({
    runPass: async () =>
      runScoringPass({
        db: handle.db,
        config,
        transport: alertTransport,
        transportName: alertTransportName,
        alertCooldownMs: tuning.alertCooldownMs,
        alertMinScore: tuning.alertMinScore,
        alertMinScoreRed: tuning.alertMinScoreRed,
        reAlertMinScoreDelta: tuning.reAlertMinScoreDelta,
        duplicateNameCooldownMs: tuning.alertDuplicateNameCooldownMs,
        eligibilityConfig,
        alertThresholds,
        // Band-only selection: everything outside the watch band classifies
        // GRAY by construction; sweeping the full active set made a scoring
        // pass take >20min against a 60s cadence (2026-07-12 audit).
        band: watchBand,
        shadowIntervalMs: tuning.shadowIntervalMs,
        signal: controller.signal,
        signals: {
          liquidityCollapseFractionBps: tuning.liquidityCollapseFractionBps,
          retentionWindowMinutes: tuning.retentionWindowMinutes,
          cohortMinSize: tuning.cohortMinSize
        },
        chartUrlBase:
          env["CHART_URL_BASE"]?.trim() || "https://dexscreener.com/robinhood"
      }),
    pollIntervalMs: tuning.scoringIntervalMs,
    signal: controller.signal,
    logger
  });

  const outcomeLoop = runOutcomeLoop({
    runPass: () =>
      runOutcomePass({
        db: handle.db,
        chainId: config.chainId,
        config: {
          horizons: tuning.outcomeHorizonsHours,
          survivalMinLiquidityFractionBps: tuning.outcomeMinLiquidityFractionBps,
          survivalMinFdvUsd: tuning.outcomeMinFdvUsd,
          batchLimit: tuning.outcomeBatchLimit
        },
        signal: controller.signal
      }),
    pollIntervalMs: tuning.outcomeIntervalMs,
    signal: controller.signal,
    logger
  });

  const performanceLoop = runPerformanceLoop({
    runPass: () =>
      runPerformancePass({
        db: handle.db,
        chainId: config.chainId,
        config: {
          horizons: tuning.performanceHorizonsHours,
          bandMinFdvUsd: tuning.performanceBandMinFdvUsd,
          bandMaxFdvUsd: tuning.performanceBandMaxFdvUsd,
          batchLimit: tuning.performanceBatchLimit
        },
        signal: controller.signal
      }),
    pollIntervalMs: tuning.performanceIntervalMs,
    signal: controller.signal,
    logger
  });

  // Advisory-only: only started when both LLM_API_KEY and JUDGMENT_MODEL are
  // set. Reuses the same fan-out `alertTransport` as scoring — one follow-up
  // message per COMPLETED brief, never a second transport instance.
  const judgmentLoop =
    judgmentRuntime === undefined
      ? undefined
      : runJudgmentLoop({
          runPass: () =>
            runJudgmentPass({
              db: handle.db,
              chainId: config.chainId,
              llm: judgmentRuntime.llm,
              model: judgmentRuntime.model,
              prompt: judgmentRuntime.prompt,
              transport: alertTransport,
              minAlertLevel: judgmentConfig.minAlertLevel,
              batchLimit: judgmentConfig.batchLimit,
              maxToolRounds: judgmentConfig.maxToolRounds,
              timeoutMs: judgmentConfig.timeoutMs,
              rebriefCooldownMs: judgmentConfig.rebriefCooldownMs,
              signal: controller.signal
            }),
          pollIntervalMs: judgmentConfig.pollIntervalMs,
          signal: controller.signal,
          logger
        });

  // Winners-retro digest goes to the ops chat (falls back to the dead-man
  // chat, then the main alert chat) and never fans out to subscribers —
  // it's operator process telemetry, not an alert.
  const retroChatId =
    env["WINNERS_RETRO_CHAT_ID"]?.trim() ||
    env["DEADMAN_CHAT_ID"]?.trim() ||
    telegram?.chatId;
  const retroTransport: AlertTransport =
    telegram === undefined || retroChatId === undefined
      ? createDryRunTransport((text) => {
          logger.info("winners_retro.dry_run", { text });
        })
      : createTelegramTransport(telegram.botToken, retroChatId);
  const winnersRetroLoop = runWinnersRetroLoop({
    runPass: () =>
      runWinnersRetroPass({
        db: handle.db,
        chainId: config.chainId,
        transport: retroTransport,
        minMultipleBps: tuning.winnersMinMultipleBps,
        minExitLiquidityUsd: tuning.winnersMinExitLiquidityUsd,
        alertMinScore: tuning.alertMinScore,
        alertMinScoreRed: tuning.alertMinScoreRed,
        eligibilityConfig,
        alertThresholds,
        signal: controller.signal
      }),
    pollIntervalMs: tuning.winnersRetroIntervalMs,
    signal: controller.signal,
    logger
  });

  // Self-service subscriptions only exist in Telegram mode; dry-run has no
  // bot to be added to.
  const subscriptionsLoop =
    telegram === undefined
      ? undefined
      : runSubscriptionsLoop({
          runPass: () =>
            runSubscriptionsPass({
              db: handle.db,
              api: createTelegramUpdatesApi(telegram.botToken),
              staticChatId: telegram.chatId,
              signal: controller.signal,
              // On-demand /score replies reuse the EXACT live scoring
              // configuration so a pasted address scores identically to the
              // scoring pass (persisted signals only, never RPC).
              scorecard: (tokenAddress) =>
                buildScorecard(
                  {
                    db: handle.db,
                    chainId: config.chainId,
                    eligibilityConfig,
                    alertThresholds,
                    signals: {
                      liquidityCollapseFractionBps:
                        tuning.liquidityCollapseFractionBps,
                      retentionWindowMinutes: tuning.retentionWindowMinutes,
                      cohortMinSize: tuning.cohortMinSize
                    }
                  },
                  tokenAddress
                ),
              ...(joinCode === undefined || joinCode === ""
                ? {}
                : { joinCode })
            }),
          pollIntervalMs: tuning.subscriptionsIntervalMs,
          signal: controller.signal,
          logger
        });

  const loops = [
    discoveryLoop,
    enrichmentLoop,
    activityLoop,
    riskLoop,
    holderLoop,
    scoringLoop,
    outcomeLoop,
    performanceLoop,
    winnersRetroLoop,
    ...(judgmentLoop === undefined ? [] : [judgmentLoop]),
    ...(subscriptionsLoop === undefined ? [] : [subscriptionsLoop])
  ];
  try {
    await Promise.all(loops);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(loops);
    throw error;
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  // Structured last words; a crash must never be silent.
  const logger = createLogger();
  logger.error("worker.crashed", { error });
  process.exit(1);
});
