# Project Context

## Problem

New-chain token launches are difficult to monitor manually because:

* Pools can be created at any time.
* Aggregators may index them after a delay.
* Displayed market capitalization may be misleading.
* Volume can be wash-traded.
* Liquidity can be removable.
* ERC-20 implementations can prevent selling or alter transfer behavior.
* Nominally independent buyers may be controlled by one entity.
* A large number of low-quality launches obscures a small number of potentially interesting candidates.

The project creates an explainable launch-monitoring funnel that converts the raw pool-creation firehose into a small manual research queue.

## Intended user

The initial user is a technically competent crypto participant who:

* Understands that ultra-small-cap tokens are highly speculative.
* Wants early monitoring beginning around $10,000 estimated FDV.
* Treats $15,000–$60,000 estimated FDV as the primary research range.
* Treats $15,000–$40,000 estimated FDV as the highest-priority research zone.
* Values contract, liquidity, distribution, and wallet analysis.
* Will manually review and execute any trade.
* Does not need the system to promise or predict profitable outcomes.

## Success condition

The initial product succeeds when it can:

1. Detect every relevant trusted-quote pool shortly after creation.
2. Survive restarts without skipping or duplicating meaningful data.
3. Reproduce defensible price, estimated FDV, and liquidity calculations.
4. Maintain minute-level historical snapshots during a token’s early life.
5. reject obvious untradeable, centrally controlled, or malformed tokens.
6. Alert within approximately one minute when a candidate enters the target range and satisfies configured rules.
7. Explain why it was accepted, rejected, upgraded, or downgraded.

## Non-goals

The project does not initially attempt to:

* Guarantee profit.
* Predict token prices.
* Replace manual contract review.
* Execute trades.
* Custody funds.
* Serve as a generalized multichain data platform.
* Infer real-world wallet identity.
* Prove that coordinated wallets share a controller.
* Produce definitive circulating-market-cap numbers for opaque launches.
* Reliably evaluate project fundamentals from marketing material alone.

## Candidate funnel

### Discovery

Record every relevant pool-creation event.

### Monitoring

Begin detailed monitoring when a pool contains a trusted quote asset and has enough observable liquidity or valuation to justify enrichment.

### Eligibility

Apply deterministic minimum requirements for valuation, liquidity, tradeability, ownership distribution, buyer count, age, and contract control.

### Ranking

Rank eligible tokens by liquidity quality, organic buying, holder growth, ownership distribution, wallet quality, and contract transparency (price structure and project evidence rejoin when real signals exist — see docs/scoring-model.md, recalibration 2026-07-11).

### Alerting

Generate progressively stronger alert levels as evidence improves.

### Manual research

The human reviews:

* Contract and proxy structure.
* Creator wallet.
* Largest holders.
* Liquidity ownership.
* Buyer funding clusters.
* Price structure.
* Project website, documentation, and social accounts.
* Estimated entry and exit impact.

## Core hypothesis

For newly launched tokens, the useful signal is not simply:

> Estimated FDV entered a target range.

The useful signal is closer to:

> A token entered the $15,000–$40,000 estimated FDV research-priority zone while quote liquidity, buyer diversity, ownership distribution, and tradeability remained acceptable, without evidence that one controller manufactured most of the activity.

This remains a research heuristic, not a guarantee of performance.

## Major uncertainties

The following must be verified during implementation:

* The official Robinhood Chain RPC details used by the project.
* DEX factory or pool-manager addresses.
* Which DEX versions are materially active.
* Canonical quote-asset addresses.
* Reliable source for contract verification and proxy metadata.
* Whether third-party charting APIs index the chain and at what latency.
* Best simulation method for the deployed routers.
* Practical holder-indexing approach at expected chain volume.
* Reliable USD price source for WETH and canonical stablecoins.
* Whether chain reorganizations require a confirmation delay beyond the initial assumption.

Do not encode guesses for these values as permanent production configuration.
