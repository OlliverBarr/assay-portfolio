# Data Sources

## Chain

Robinhood Chain is an Arbitrum Orbit L2 (Ethereum L2, ETH gas token) launched to mainnet on 2026-07-01.

| Item | Value | Verification source | Verified on | Status |
|---|---|---|---|---|
| Chain ID | 4663 | [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting/); cross-checked on-chain via `eth_chainId` against the public RPC | 2026-07-10 | Verified |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` (rate-limited; Alchemy `robinhood-mainnet.g.alchemy.com` recommended for production; sequencer feed `wss://feed.mainnet.chain.robinhood.com`) | [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting/) | 2026-07-10 | Verified |
| Explorer | `https://robinhoodchain.blockscout.com` (Blockscout) | [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting/); also [Robinhood support article](https://robinhood.com/us/en/support/articles/robinhood-chain-mainnet/) | 2026-07-10 | Verified |

Note: the public RPC is a full node, not archive — historical `eth_getCode`/state queries fail; use an archive provider (e.g. Alchemy) for historical reads, per [Robinhood docs](https://docs.robinhood.com/chain/connecting/).

## DEX deployments

Uniswap is the dominant verified DEX: Uniswap v2, v3, v4, and UniswapX are live from launch day, and Uniswap Labs states Uniswap "serves as the primary public AMM on Robinhood Chain" ([blog.uniswap.org/robinhood-chain-is-live](https://blog.uniswap.org/robinhood-chain-is-live), 2026-07-02). A second venue, Arcus (dYdX-team spot/perps DEX for stock tokens), also launched on the chain ([dydx.xyz/blog/a-new-arc](https://www.dydx.xyz/blog/a-new-arc)) but is not an AMM with a public factory.

| DEX | Version | Factory / manager | Start block | Source | Status |
|---|---|---|---:|---|---|
| Uniswap | V2 | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` (UniswapV2Factory) | 9486 [^v2block] | [developers.uniswap.org/docs/protocols/v2/deployments](https://developers.uniswap.org/docs/protocols/v2/deployments) | Verified (2026-07-10) |
| Uniswap | V3 | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` (UniswapV3Factory) | 8930 [^v3block] | [developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments) | Verified (2026-07-10) |
| Uniswap | V4 | `0x8366a39CC670B4001A1121B8F6A443A643e40951` (PoolManager) | 9070 [^v4block] | [developers.uniswap.org/docs/protocols/v4/deployments](https://developers.uniswap.org/docs/protocols/v4/deployments) | Verified (2026-07-10) |

### Trade-route periphery

| Contract | Address | Source | Status |
|---|---|---|---|
| UniswapV2Router02 | `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` | [developers.uniswap.org/docs/protocols/v2/deployments](https://developers.uniswap.org/docs/protocols/v2/deployments) | Verified (2026-07-10) [^v2router] |
| QuoterV2 (V3 lens) | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` | [developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments) | Verified (2026-07-10) [^v3quoter] |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` | Same V3 deployments page | Listed (2026-07-10) — not independently probed |
| SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` | Same V3 deployments page | Listed (2026-07-10) — not independently probed |
| V4 PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | [developers.uniswap.org/docs/protocols/v4/deployments](https://developers.uniswap.org/docs/protocols/v4/deployments) | Listed (2026-07-10) — not independently probed |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Same V3 deployments page | Listed (2026-07-10) — not independently probed |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | Canonical cross-chain deployment ([multicall3.com](https://www.multicall3.com/deployments)) | Verified (2026-07-11) [^multicall3] |

[^v2router]: On-chain checks via the public RPC at block 6,524,708 (2026-07-10): `eth_getCode` non-empty (21,902 bytes); `factory()` returned the verified V2 factory `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` and `WETH()` the canonical WETH, binding the router to this deployment; `getAmountsOut(0.001 WETH -> USDG)` on the live V2 WETH/USDG pair `0x8803c117ccae7B5146297876c2A25DF135141C4d` returned 1,782,557 raw USDG (≈$1.78, sane vs. spot). Blockscout reports the address as verified contract `UniswapV2Router02`.
[^v3quoter]: On-chain checks via the public RPC at block 6,524,708 (2026-07-10): `eth_getCode` non-empty (8,273 bytes); staticcall `quoteExactInputSingle(WETH -> USDG, fee 500)` — fee tier read from the live V3 WETH/USDG pool `0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a` — for 0.001 WETH returned 1,791,958 raw USDG (≈$1.79, non-zero and consistent with the V2 quote above). Blockscout-verified ABI at the address carries the QuoterV2 signatures (`quoteExactInputSingle`, `WETH9`).
[^multicall3]: `eth_getCode` via the public RPC (2026-07-11) returned the canonical Multicall3 runtime bytecode (dispatcher selectors `4d2301cc`/`a8b0574e`/`bce38bd7` present). Used by the viem client for read batching (`packages/chain/src/client.ts`).

[^v2block]: Block of the first `PairCreated` event (topic `0x0d3648bd…`), found via `eth_getLogs` on the official public RPC (2026-07-10). The V2 factory constructor emits no event and the public RPC prunes historical state, so the exact deployment block is slightly earlier; 9486 is the correct indexing start (no pairs exist before it).
[^v3block]: Deployment block. The V3 factory constructor emits `OwnerChanged` (topic `0xb532073b…`); block of the factory's first log via `eth_getLogs` on the official public RPC (2026-07-10), tx `0x8add72fbcad4bf7732336de35dcd06b582c1501d0832c4710a30850a7cff8977`.
[^v4block]: Deployment block. The PoolManager constructor emits `OwnershipTransferred` (topic `0x8be0079c…`); block of the contract's first log via `eth_getLogs` on the official public RPC (2026-07-10), tx `0x4fb28d4935866f462582c6c931c6f2705e55f5be5eb178c7d8d9329a95c44c41`.

## Quote assets

| Asset | Address | Decimals | Canonical source | Status |
|---|---|---:|---|---|
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | 18 | [docs.robinhood.com/chain/contracts](https://docs.robinhood.com/chain/contracts/) and listed as "L2 Weth" (canonical bridge WETH) on [docs.robinhood.com/chain/protocol-contracts](https://docs.robinhood.com/chain/protocol-contracts/); `symbol()`/`decimals()` confirmed on-chain via public RPC | Verified (2026-07-10) |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 6 | [docs.robinhood.com/chain/contracts](https://docs.robinhood.com/chain/contracts/) (Robinhood-designated canonical stablecoin, Paxos "Global Dollar"); `symbol()`="USDG", `decimals()`=6 confirmed on-chain via public RPC | Verified (2026-07-10) |
| USDC | `0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8` (canonical bridged, "USD Coin") | 6 | No Circle-native USDC: Robinhood Chain absent from [Circle's USDC contract-address registry](https://developers.circle.com/stablecoins/usdc-contract-addresses) (2026-07-10). Bridged address derived on-chain via `calculateL2TokenAddress(L1 USDC)` on the official L2 Gateway Router `0x1E324B9316138CA9a73F960213621AD1aaf01B89` ([docs.robinhood.com/chain/protocol-contracts](https://docs.robinhood.com/chain/protocol-contracts/)); code deployed, `decimals()`=6 confirmed via public RPC | Verified (2026-07-10) — bridged only, see note |
| VIRTUAL | `0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31` | 18 | [whitepaper.virtuals.io/info-hub/important-links-and-resources/contract-address](https://whitepaper.virtuals.io/info-hub/important-links-and-resources/contract-address) ("$VIRTUAL Token Address (Robinhood Chain)", Virtuals Protocol's official whitepaper); `symbol()`/`decimals()` confirmed on-chain via public RPC | Verified (2026-07-12) — see note |

**Project-assumption note:** there is no native (Circle-issued) USDC on Robinhood Chain, and the canonical bridged USDC held only ~493.58 USDC total supply on 2026-07-10 (`totalSupply()` via public RPC) — economically negligible. The chain's designated stablecoin is **USDG** (listed by Robinhood alongside WETH as a canonical token contract and named in official bridging routes). Quote-asset logic should treat WETH and USDG as the primary quotes, not USDC.

**VIRTUAL verification note:** VIRTUAL is CONFIRMED canonical directly from
Virtuals Protocol's official whitepaper contract-address page — not inferred
from pool activity. Empirics corroborate the paper source (2026-07-12): 3,156
discovered pools already pair against VIRTUAL; the deepest, VIRTUAL/WETH pool
`0xd95e8e2Cd04c207625C6F23c974d365a5F3A91D3`, holds ~$892k quote-side /
~$1.78M total liquidity, with price (~$0.64) consistent across 4
independently-checked pools (arb parity with VIRTUAL's price elsewhere).
VIRTUAL is Robinhood Chain's day-one AI-agent launchpad currency —
graduations alone seed roughly 42k VIRTUAL-quoted pools — which is the
actual justification for allow-listing it: a volume decision, not a
stablecoin-parity one. Documented anomaly: on-chain `totalSupply()` reads
5.05B against VIRTUAL's canonical 1B global supply; irrelevant to quote
pricing (enrichment reads per-pool price, never VIRTUAL's own token supply)
but flagged here so it is never mistaken for a bridging or minting defect.

USDC: not canonically deployed on Robinhood Chain as of 2026-07-12 — absent
from both Circle's contract-address registry and Robinhood's own chain
token registry (which lists only WETH and USDG as canonical tokens).
Correctly not allow-listed as a primary quote asset. Revisit trigger:
Circle's [contract-addresses page](https://developers.circle.com/stablecoins/usdc-contract-addresses)
or [docs.robinhood.com/chain/contracts](https://docs.robinhood.com/chain/contracts/)
lists a chain-4663 USDC address.

## Third-party enrichment

| Provider | Purpose | Authority | Expected limitations |
|---|---|---|---|
| DexScreener | Chart and market enrichment | Secondary | Indexing latency and rate limits |
| Blockscout | Verification and explorer metadata | Secondary | Explorer indexing delay |
| RPC provider | On-chain state and logs | Primary | Rate limits and temporary errors |