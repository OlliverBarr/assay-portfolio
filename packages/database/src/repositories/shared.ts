/**
 * PostgreSQL's extended query protocol caps a single statement at 65,534
 * bind parameters (Int16 on the wire; postgres.js throws
 * MAX_PARAMETERS_EXCEEDED, and PGlite's serializer rejects >32,767). Any
 * query or insert whose parameter count scales with table population MUST
 * go through these chunk helpers — observed live 2026-07-11 when a
 * 67,932-address lookup crash-looped the worker.
 */
export const ADDRESS_CHUNK_SIZE = 30_000;
/** Rows per bulk write; widest table is ~25 columns -> well under the cap. */
export const INSERT_CHUNK_SIZE = 2_000;

export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
