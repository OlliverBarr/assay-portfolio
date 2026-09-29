import type { Hex } from "viem";

/**
 * Product-neutral on-chain read primitives used by risk analysis. This module
 * exposes standard slot layouts and ABI fragments only — deciding what a given
 * selector or storage value *means* for token safety is product logic and lives
 * in `@assay/risk-engine`, never here.
 */

/** EIP-1967 logic implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
export const eip1967ImplementationSlot: Hex =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** EIP-1967 beacon slot: keccak256("eip1967.proxy.beacon") - 1. */
export const eip1967BeaconSlot: Hex =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

/** EIP-1967 admin slot: keccak256("eip1967.proxy.admin") - 1. */
export const eip1967AdminSlot: Hex =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

/** OpenZeppelin transparent-proxy legacy implementation slot (org.zeppelinos). */
export const legacyImplementationSlot: Hex =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

/** Ownable `owner()` view — read the privileged account, not to classify it. */
export const ownableAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }]
  }
] as const;

/** Uniswap V2 router `getAmountsOut` — route quote for tradeability checks. */
export const uniswapV2RouterAbi = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  }
] as const;

/** Uniswap V3 QuoterV2 `quoteExactInputSingle` — single-hop route quote. */
export const uniswapV3QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" }
        ]
      }
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" }
    ]
  }
] as const;
