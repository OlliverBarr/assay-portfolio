import {
  getActivitySnapshotAt,
  getHolderSnapshotAt,
  getPool,
  getTokenRiskAt,
  getTokensByAddresses,
  getTradeSimulationAt,
  listPoolSnapshots,
  type Db,
  type PoolSnapshotRow
} from "@assay/database";

import type {
  BundleAlert,
  BundlePool,
  BundleToken,
  EvidenceBundle,
  SourcedRow,
  UntrustedString
} from "./types.js";

/**
 * As-of evidence assembly for the judgment layer.
 *
 * Every field is reconstructed from append-only history via `<= asOf` reads
 * (the same pattern `buildEntryFeatures` in the performance pass uses for
 * historical labeling), so the same assembly serves a live brief (asOf =
 * alert sent_at) and a replay brief (asOf = a historical band entry) without
 * branching. `assertNoLookahead` is the leakage guard: it is always called
 * before returning, so a bug that reaches into the future fails loudly
 * instead of silently corrupting a brief.
 */
export interface AssembleBundleArgs {
  readonly db: Db;
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly poolAddress: string;
  readonly asOf: Date;
  readonly mode: EvidenceBundle["mode"];
  readonly alert?: BundleAlert | null;
}

/** Stages `JudgmentBundleError` can be raised from. */
export type JudgmentBundleErrorStage =
  | "POOL_NOT_FOUND"
  | "TOKEN_NOT_FOUND"
  | "LOOKAHEAD";

export interface JudgmentBundleErrorContext {
  readonly chainId: number;
  /** Pool address the bundle was being assembled for. */
  readonly pool: string;
  /** Token address the bundle was being assembled for. */
  readonly token: string;
  readonly stage: JudgmentBundleErrorStage;
  readonly cause?: unknown;
}

/**
 * Structured failure for bundle assembly / the lookahead guard. Carries
 * enough context (chain, pool, token, stage) to diagnose a bad brief without
 * re-deriving it from a bare message string.
 */
export class JudgmentBundleError extends Error {
  override readonly name = "JudgmentBundleError";
  readonly chainId: number;
  readonly pool: string;
  readonly token: string;
  readonly stage: JudgmentBundleErrorStage;

  constructor(message: string, context: JudgmentBundleErrorContext) {
    super(
      `${message} (chain ${context.chainId}, pool ${context.pool}, token ${context.token}, stage ${context.stage})`,
      context.cause === undefined ? undefined : { cause: context.cause }
    );
    this.chainId = context.chainId;
    this.pool = context.pool;
    this.token = context.token;
    this.stage = context.stage;
  }
}

/** Attacker-controlled string cap; keeps a hostile token name from bloating prompts. */
const UNTRUSTED_STRING_MAX_LENGTH = 128;

/** C0 (incl. DEL) and C1 control characters — never rendered, ever. */
// eslint-disable-next-line no-control-regex -- stripping control chars is the point
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

/** Wraps a possibly-null raw string as `UntrustedString`: stripped, length-capped. */
function toUntrustedString(value: string | null): UntrustedString | null {
  if (value === null) return null;
  const stripped = value.replace(CONTROL_CHARS_RE, "");
  return {
    text: stripped.slice(0, UNTRUSTED_STRING_MAX_LENGTH),
    provenance: "ATTACKER_STRING"
  };
}

/**
 * As-of assembly from append-only history. Throws `JudgmentBundleError` when
 * the pool or token row is missing (nothing to brief on); otherwise reads
 * every history table in parallel at (or before) `asOf` and returns a bundle
 * that has already passed the lookahead guard.
 */
export async function assembleEvidenceBundle(
  args: AssembleBundleArgs
): Promise<EvidenceBundle> {
  const { db, chainId, tokenAddress, poolAddress, asOf, mode } = args;
  const alert = args.alert ?? null;

  const [poolRow, tokenRows] = await Promise.all([
    getPool(db, chainId, poolAddress),
    getTokensByAddresses(db, chainId, [tokenAddress])
  ]);

  if (poolRow === undefined) {
    throw new JudgmentBundleError("pool not found", {
      chainId,
      pool: poolAddress,
      token: tokenAddress,
      stage: "POOL_NOT_FOUND"
    });
  }
  const tokenRow = tokenRows[0];
  if (tokenRow === undefined) {
    throw new JudgmentBundleError("token not found", {
      chainId,
      pool: poolAddress,
      token: tokenAddress,
      stage: "TOKEN_NOT_FOUND"
    });
  }

  const [snapshots, activity, holders, risk, simulation] = await Promise.all([
    listPoolSnapshots(db, chainId, poolAddress),
    getActivitySnapshotAt(db, chainId, poolAddress, asOf),
    getHolderSnapshotAt(db, chainId, tokenAddress, asOf),
    getTokenRiskAt(db, chainId, tokenAddress, asOf),
    getTradeSimulationAt(db, chainId, tokenAddress, asOf)
  ]);

  const asOfMs = asOf.getTime();
  const marketSeries: SourcedRow<PoolSnapshotRow>[] = snapshots
    .filter((row) => row.capturedAt.getTime() <= asOfMs)
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
    .map((row) => ({
      row,
      source: { table: "pool_snapshots" as const, rowId: String(row.id) }
    }));

  const pool: BundlePool = {
    address: poolRow.poolAddress,
    dex: poolRow.dex,
    kind: poolRow.factoryKind,
    createdAtBlock: String(poolRow.createdAtBlock),
    discoveredAt: poolRow.discoveredAt,
    quoteTokenAddress: poolRow.quoteTokenAddress
  };

  const token: BundleToken = {
    address: tokenRow.address,
    decimals: tokenRow.decimals,
    totalSupply: tokenRow.totalSupply,
    deployerAddress: tokenRow.deployerAddress,
    deployerStatus: tokenRow.deployerStatus,
    name: toUntrustedString(tokenRow.name),
    symbol: toUntrustedString(tokenRow.symbol)
  };

  const bundle: EvidenceBundle = {
    chainId,
    mode,
    asOf,
    alert,
    token,
    pool,
    marketSeries,
    activity:
      activity === undefined
        ? null
        : {
            row: activity,
            source: {
              table: "pool_activity_snapshots" as const,
              rowId: String(activity.id)
            }
          },
    holders:
      holders === undefined
        ? null
        : {
            row: holders,
            source: {
              table: "token_holder_snapshots" as const,
              rowId: String(holders.id)
            }
          },
    risk:
      risk === undefined
        ? null
        : {
            row: risk,
            source: { table: "token_risks" as const, rowId: String(risk.id) }
          },
    simulation:
      simulation === undefined
        ? null
        : {
            row: simulation,
            source: {
              table: "trade_simulations" as const,
              rowId: String(simulation.id)
            }
          }
  };

  assertNoLookahead(bundle);
  return bundle;
}

/**
 * Leakage guard: throws `JudgmentBundleError` (stage `LOOKAHEAD`) if any
 * bundled row's own timestamp column postdates `asOf`. Every table has a
 * different column name (`capturedAt` for snapshots, `assessedAt` for
 * risk, `simulatedAt` for simulations) — always read the row's own column,
 * never a shared/derived one.
 */
export function assertNoLookahead(bundle: EvidenceBundle): void {
  const asOfMs = bundle.asOf.getTime();

  const fail = (detail: string): never => {
    throw new JudgmentBundleError(`evidence row postdates asOf: ${detail}`, {
      chainId: bundle.chainId,
      pool: bundle.pool.address,
      token: bundle.token.address,
      stage: "LOOKAHEAD"
    });
  };

  for (const point of bundle.marketSeries) {
    if (point.row.capturedAt.getTime() > asOfMs) {
      fail(
        `pool_snapshots:${point.source.rowId} capturedAt=${point.row.capturedAt.toISOString()}`
      );
    }
  }
  if (bundle.activity !== null && bundle.activity.row.capturedAt.getTime() > asOfMs) {
    fail(
      `pool_activity_snapshots:${bundle.activity.source.rowId} capturedAt=${bundle.activity.row.capturedAt.toISOString()}`
    );
  }
  if (bundle.holders !== null && bundle.holders.row.capturedAt.getTime() > asOfMs) {
    fail(
      `token_holder_snapshots:${bundle.holders.source.rowId} capturedAt=${bundle.holders.row.capturedAt.toISOString()}`
    );
  }
  if (bundle.risk !== null && bundle.risk.row.assessedAt.getTime() > asOfMs) {
    fail(
      `token_risks:${bundle.risk.source.rowId} assessedAt=${bundle.risk.row.assessedAt.toISOString()}`
    );
  }
  if (
    bundle.simulation !== null &&
    bundle.simulation.row.simulatedAt.getTime() > asOfMs
  ) {
    fail(
      `trade_simulations:${bundle.simulation.source.rowId} simulatedAt=${bundle.simulation.row.simulatedAt.toISOString()}`
    );
  }
}
