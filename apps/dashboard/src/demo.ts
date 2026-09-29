import {
  insertAlertSent,
  insertPools,
  insertScoreResult,
  insertTokenPerformance,
  insertTokens,
  type Db
} from "@assay/database";
import { createTestDatabase } from "@assay/database/testing";

import { buildDashboardApp } from "./app.js";

const CHAIN_ID = 4663;
const POOL = "0x1111111111111111111111111111111111111111";
const BASE = "0x3333333333333333333333333333333333333333";
const QUOTE = "0x4444444444444444444444444444444444444444";

function loadPort(env: NodeJS.ProcessEnv): number {
  const raw = env["DASHBOARD_PORT"]?.trim();
  if (raw === undefined || raw === "") return 4600;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("DASHBOARD_PORT must be an integer between 1 and 65535");
  }
  return port;
}

/** Loads one deterministic, fictional candidate into the dashboard database. */
export async function seedDemoData(db: Db, observedAt: Date): Promise<void> {
  await insertPools(db, [
    {
      chainId: CHAIN_ID,
      poolAddress: POOL,
      factoryAddress: "0x2222222222222222222222222222222222222222",
      dex: "uniswap",
      factoryKind: "uniswap-v2",
      token0Address: BASE,
      token1Address: QUOTE,
      quoteTokenAddress: QUOTE,
      baseTokenAddress: BASE,
      createdAtBlock: 100n,
      createdTxHash: `0x${"ab".repeat(32)}`,
      createdLogIndex: 0
    }
  ]);
  await insertTokens(db, [
    {
      chainId: CHAIN_ID,
      address: BASE,
      firstSeenBlock: 100n,
      name: "Demo Token",
      symbol: "DEMO"
    }
  ]);
  await insertTokenPerformance(db, {
    chainId: CHAIN_ID,
    tokenAddress: BASE,
    poolAddress: POOL,
    horizonHours: 72,
    bandMinFdvUsd: "10000",
    bandMaxFdvUsd: "100000",
    enteredAt: observedAt,
    entryBlock: 100n,
    entryPriceUsd: "0.001",
    entryFdvUsd: "25000",
    maxMultipleBps: 25_000,
    maxDrawdownBps: 1_000,
    minutesToPeak: 30,
    snapshotsInWindow: 5,
    entryFeatures: { quoteLiquidityUsd: 50_000 },
    details: {}
  });
  await insertScoreResult(db, {
    chainId: CHAIN_ID,
    tokenAddress: BASE,
    poolAddress: POOL,
    blockNumber: 100n,
    scoredAt: observedAt,
    eligible: true,
    score: 82,
    components: {},
    alertLevel: "GREEN",
    positiveReasons: [],
    riskReasons: []
  });
  await insertAlertSent(db, {
    chainId: CHAIN_ID,
    tokenAddress: BASE,
    poolAddress: POOL,
    alertLevel: "GREEN",
    score: 82,
    reason: "demo band entry",
    transport: "dry-run",
    delivered: true
  });
}

async function main(): Promise<void> {
  const handle = await createTestDatabase();
  await seedDemoData(handle.db, new Date());
  const app = buildDashboardApp({ db: handle.db, chainId: CHAIN_ID });
  const host = process.env["DASHBOARD_HOST"]?.trim() || "127.0.0.1";
  const port = loadPort(process.env);

  const close = async (): Promise<void> => {
    await app.close();
    await handle.close();
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));

  await app.listen({ host, port });
  process.stdout.write(`Demo dashboard: http://${host}:${port}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
