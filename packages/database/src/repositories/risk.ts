import {
  and,
  desc,
  eq,
  lte,
} from "drizzle-orm";
import type { Db } from "../client.js";
import {
  tokenRisks,
  tradeSimulations
} from "../schema.js";

export type TokenRiskInsert = typeof tokenRisks.$inferInsert;

export type TokenRiskRow = typeof tokenRisks.$inferSelect;

export type TradeSimulationInsert = typeof tradeSimulations.$inferInsert;

export type TradeSimulationRow = typeof tradeSimulations.$inferSelect;

/** Append a risk assessment. Never updates existing rows — history is kept. */
export async function insertTokenRisk(
  db: Db,
  row: TokenRiskInsert
): Promise<TokenRiskRow> {
  const [inserted] = await db.insert(tokenRisks).values(row).returning();
  if (inserted === undefined) {
    throw new Error("insertTokenRisk returned no row");
  }
  return inserted;
}

/** Append a trade simulation. Never updates existing rows. */
export async function insertTradeSimulation(
  db: Db,
  row: TradeSimulationInsert
): Promise<TradeSimulationRow> {
  const [inserted] = await db
    .insert(tradeSimulations)
    .values(row)
    .returning();
  if (inserted === undefined) {
    throw new Error("insertTradeSimulation returned no row");
  }
  return inserted;
}

/** Most recent trade simulation for a token, or undefined when never simulated. */
export async function getLatestTradeSimulation(
  db: Db,
  chainId: number,
  tokenAddress: string
): Promise<TradeSimulationRow | undefined> {
  const rows = await db
    .select()
    .from(tradeSimulations)
    .where(
      and(
        eq(tradeSimulations.chainId, chainId),
        eq(tradeSimulations.tokenAddress, tokenAddress)
      )
    )
    .orderBy(desc(tradeSimulations.simulatedAt), desc(tradeSimulations.id))
    .limit(1);
  return rows[0];
}

/** Risk rows for one token, oldest first. */
export async function listTokenRisks(
  db: Db,
  chainId: number,
  tokenAddress: string
): Promise<TokenRiskRow[]> {
  return db
    .select()
    .from(tokenRisks)
    .where(
      and(
        eq(tokenRisks.chainId, chainId),
        eq(tokenRisks.tokenAddress, tokenAddress)
      )
    )
    .orderBy(tokenRisks.assessedAt, tokenRisks.id);
}

/** Most recent risk row for a pool's route, or undefined. */
export async function getLatestTokenRiskForPool(
  db: Db,
  chainId: number,
  poolAddress: string
): Promise<TokenRiskRow | undefined> {
  const rows = await db
    .select()
    .from(tokenRisks)
    .where(
      and(
        eq(tokenRisks.chainId, chainId),
        eq(tokenRisks.poolAddress, poolAddress)
      )
    )
    .orderBy(desc(tokenRisks.assessedAt), desc(tokenRisks.id))
    .limit(1);
  return rows[0];
}

/**
 * Latest risk assessment for a token at or before `at`, or undefined. Backs
 * historical entry-feature reconstruction on an append-only table.
 */
export async function getTokenRiskAt(
  db: Db,
  chainId: number,
  tokenAddress: string,
  at: Date
): Promise<TokenRiskRow | undefined> {
  const rows = await db
    .select()
    .from(tokenRisks)
    .where(
      and(
        eq(tokenRisks.chainId, chainId),
        eq(tokenRisks.tokenAddress, tokenAddress),
        lte(tokenRisks.assessedAt, at)
      )
    )
    .orderBy(desc(tokenRisks.assessedAt), desc(tokenRisks.id))
    .limit(1);
  return rows[0];
}

/**
 * Latest trade simulation for a token at or before `at` (as-of read),
 * mirroring `getTokenRiskAt`'s pattern on an append-only table.
 */
export async function getTradeSimulationAt(
  db: Db,
  chainId: number,
  tokenAddress: string,
  at: Date
): Promise<TradeSimulationRow | undefined> {
  const rows = await db
    .select()
    .from(tradeSimulations)
    .where(
      and(
        eq(tradeSimulations.chainId, chainId),
        eq(tradeSimulations.tokenAddress, tokenAddress),
        lte(tradeSimulations.simulatedAt, at)
      )
    )
    .orderBy(desc(tradeSimulations.simulatedAt), desc(tradeSimulations.id))
    .limit(1);
  return rows[0];
}
