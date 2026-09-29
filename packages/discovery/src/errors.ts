/** Raised when a log from a watched factory cannot be decoded. */
export class PoolDecodeError extends Error {
  override readonly name = "PoolDecodeError";
  readonly blockNumber: bigint;
  readonly logIndex: number;

  constructor(
    message: string,
    context: { blockNumber: bigint; logIndex: number; cause?: unknown }
  ) {
    super(
      `${message} (block ${context.blockNumber}, logIndex ${context.logIndex})`,
      context.cause === undefined ? undefined : { cause: context.cause }
    );
    this.blockNumber = context.blockNumber;
    this.logIndex = context.logIndex;
  }
}

/**
 * Raised when a discovery pass cannot safely continue. The cursor is left at
 * the last fully persisted block; the next pass resumes there. Discovery
 * NEVER skips a range to keep running.
 */
export class DiscoveryHaltError extends Error {
  override readonly name = "DiscoveryHaltError";
  readonly fromBlock: bigint;
  readonly toBlock: bigint;

  constructor(
    message: string,
    context: { fromBlock: bigint; toBlock: bigint; cause?: unknown }
  ) {
    super(
      `${message} (range ${context.fromBlock}-${context.toBlock})`,
      context.cause === undefined ? undefined : { cause: context.cause }
    );
    this.fromBlock = context.fromBlock;
    this.toBlock = context.toBlock;
  }
}
