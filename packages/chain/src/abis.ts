import { parseAbiItem, toEventSelector, type Hex } from "viem";

import type { FactoryKind } from "./config.js";

/** Uniswap V2 factory: PairCreated(token0, token1, pair, allPairsLength). */
export const uniswapV2PairCreatedEvent = parseAbiItem(
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)"
);

/** Uniswap V3 factory: PoolCreated(token0, token1, fee, tickSpacing, pool). */
export const uniswapV3PoolCreatedEvent = parseAbiItem(
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
);

/** Uniswap V2 pair: Swap(sender, amount0In, amount1In, amount0Out, amount1Out, to). */
export const uniswapV2SwapEvent = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
);

/** Uniswap V3 pool: Swap(sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick). */
export const uniswapV3SwapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
);


export const uniswapV2PairCreatedTopic: Hex = toEventSelector(
  uniswapV2PairCreatedEvent
);

export const uniswapV3PoolCreatedTopic: Hex = toEventSelector(
  uniswapV3PoolCreatedEvent
);

export const uniswapV2SwapTopic: Hex = toEventSelector(uniswapV2SwapEvent);

export const uniswapV3SwapTopic: Hex = toEventSelector(uniswapV3SwapEvent);


/** topic0 of the pool-creation event each factory kind emits. */
export const poolCreationTopicByKind: Readonly<Record<FactoryKind, Hex>> = {
  "uniswap-v2": uniswapV2PairCreatedTopic,
  "uniswap-v3": uniswapV3PoolCreatedTopic
};

/** topic0 of the swap event each pool kind emits. */
export const swapTopicByKind: Readonly<Record<FactoryKind, Hex>> = {
  "uniswap-v2": uniswapV2SwapTopic,
  "uniswap-v3": uniswapV3SwapTopic
};
