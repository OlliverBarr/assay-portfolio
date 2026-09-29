export class SwapDecodeError extends Error {
  override readonly name = "SwapDecodeError";
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
 * Raised when activity ingestion cannot safely continue. The activity cursor
 * stays at the last fully committed chunk; the next pass rescans the range.
 */
export class ActivityHaltError extends Error {
  override readonly name = "ActivityHaltError";
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
