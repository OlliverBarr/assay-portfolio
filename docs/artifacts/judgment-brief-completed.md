# Artifact: a delivered judgment brief with 20/20 verified citations

> Research artifact only. It is not financial or investment advice. It does
> not recommend a token or promise a result.

One `judgment_briefs` row (production, 2026-07-21, prompt v2,
gpt-4.1-mini) for token "Honk", generated for alert id 205 strictly after
that alert was delivered. All 20 evidence citations resolved against
append-only history rows with exact value matches, so `status` is
`COMPLETED` and the brief went out as a Telegram follow-up
(`delivery: SENT`).

Two storage properties visible below:

- `thesis` is exactly 600 characters: free-text fields from the model are
  length-capped by the schema validator before persistence, so a stored
  value can end mid-word at the cap.
- Every load-bearing number in `risk_calls` / `disconfirming` carries an
  `EvidencePointer` (`table`, `rowId`, `field`, `claimedValue`); the full
  pointer list is in the citations table below.

```json
{
    "id": 151,
    "chain_id": 4663,
    "token_address": "0x2f51C2f092CB7a048Ae71a7aCb293101d1C34b44",
    "pool_address": "0xc631d67f61734B2B817a75ddDDE5C3c12603b0Fb",
    "mode": "LIVE",
    "alert_id": 205,
    "as_of": "2026-07-21T03:21:50.793+00:00",
    "prompt_name": "research-brief",
    "prompt_version": 2,
    "template_hash": "9633d3c4bed5dff9adad021b2d53d7baa6f5e74107cf7ffbf764cc72a678e7ee",
    "model": "gpt-4.1-mini",
    "status": "COMPLETED",
    "thesis": "This launch shows moderate initial liquidity and holder distribution with no deployer history of prior launches, indicating a new deployer. The token has a reasonable number of unique buyers and buy activity, and the price has experienced volatility but no extreme drawdowns yet. The base rate for similar launches with comparable liquidity and holder count shows a low death rate (1.08%) and a moderate chance of running up (41.94%) with a median max multiple of about 1.56x, suggesting this launch has a decent chance of survival and some upside potential. However, the contract source is un-verify",
    "confidence_bps": 6500,
    "recommendation": "WATCH",
    "risk_calls": [
        {
            "tag": "RUG_LP_PULL",
            "risk": "RUG_LP_PULL",
            "evidence": [
                {
                    "field": "riskReasons",
                    "rowId": "220991",
                    "table": "token_risks",
                    "claimedValue": "Contract source is not verified"
                }
            ],
            "severity": "MEDIUM"
        },
        {
            "tag": "CONCENTRATION_DUMP",
            "risk": "CONCENTRATION_DUMP",
            "evidence": [
                {
                    "field": "largestHolderPctBps",
                    "rowId": "289595",
                    "table": "token_holder_snapshots",
                    "claimedValue": "6251"
                },
                {
                    "field": "adjustedTop10PctBps",
                    "rowId": "289595",
                    "table": "token_holder_snapshots",
                    "claimedValue": "6105"
                }
            ],
            "severity": "MEDIUM"
        },
        {
            "tag": "NO_FOLLOW_THROUGH",
            "risk": "NO_FOLLOW_THROUGH",
            "evidence": [
                {
                    "field": "priceUsd",
                    "rowId": "29779293",
                    "table": "pool_snapshots",
                    "claimedValue": "0.000023445964401367"
                },
                {
                    "field": "priceUsd",
                    "rowId": "30043753",
                    "table": "pool_snapshots",
                    "claimedValue": "0.000013143426646191"
                }
            ],
            "severity": "LOW"
        }
    ],
    "disconfirming": [
        {
            "claim": "The token has a successful trade simulation with no revert or sell issues.",
            "evidence": [
                {
                    "field": "sellStatus",
                    "rowId": "220991",
                    "table": "trade_simulations",
                    "claimedValue": "PASS"
                },
                {
                    "field": "buyStatus",
                    "rowId": "220991",
                    "table": "trade_simulations",
                    "claimedValue": "PASS"
                }
            ]
        },
        {
            "claim": "The token has a moderate number of unique buyers and buy activity, indicating some genuine interest.",
            "evidence": [
                {
                    "field": "uniqueBuyers1h",
                    "rowId": "4927800",
                    "table": "pool_activity_snapshots",
                    "claimedValue": "64"
                },
                {
                    "field": "buyCount20m",
                    "rowId": "4927800",
                    "table": "pool_activity_snapshots",
                    "claimedValue": "67"
                }
            ]
        }
    ],
    "what_would_change": [
        "Deployer launches multiple successful tokens with verified contracts.",
        "Largest holder percentage drops below 3000 bps (30%).",
        "Price sustains a strong upward trend with increasing liquidity over 72 hours."
    ],
    "citations_total": 20,
    "citations_verified": 20,
    "delivery": "SENT",
    "latency_ms": 14136,
    "tokens_in": 11126,
    "tokens_out": 956
}
```

## The 20 machine-checked citations (`judgment_citations`)

Each row was re-fetched from its cited append-only table after generation
and compared against `claimed_value`. All 20 verified.

```json
[
    {
        "claim_key": "thesis",
        "cited_table": "pool_snapshots",
        "cited_row_id": 29779293,
        "cited_field": "quoteLiquidityUsd",
        "claimed_value": "7832.400302127176107894",
        "verified": true
    },
    {
        "claim_key": "thesis",
        "cited_table": "token_holder_snapshots",
        "cited_row_id": 289595,
        "cited_field": "adjustedHolderCount",
        "claimed_value": "61",
        "verified": true
    },
    {
        "claim_key": "thesis",
        "cited_table": "token_holder_snapshots",
        "cited_row_id": 289595,
        "cited_field": "largestHolderPctBps",
        "claimed_value": "6251",
        "verified": true
    },
    {
        "claim_key": "thesis",
        "cited_table": "pool_activity_snapshots",
        "cited_row_id": 4927800,
        "cited_field": "uniqueBuyers1h",
        "claimed_value": "64",
        "verified": true
    },
    {
        "claim_key": "thesis",
        "cited_table": "pool_activity_snapshots",
        "cited_row_id": 4927800,
        "cited_field": "buyCount20m",
        "claimed_value": "67",
        "verified": true
    },
    {
        "claim_key": "thesis",
        "cited_table": "pool_snapshots",
        "cited_row_id": 29779293,
        "cited_field": "priceUsd",
        "claimed_value": "0.000023445964401367",
        "verified": true
    },
    {
        "claim_key": "thesis",
        "cited_table": "token_risks",
        "cited_row_id": 220991,
        "cited_field": "riskReasons",
        "claimed_value": "Contract source is not verified",
        "verified": true
    },
    {
        "claim_key": "thesis",
        "cited_table": "token_risks",
        "cited_row_id": 220991,
        "cited_field": "simulationStatus",
        "claimed_value": "PASS",
        "verified": true
    },
    {
        "claim_key": "thesis",
        "cited_table": "judgment_tool_calls",
        "cited_row_id": 2,
        "cited_field": "diedPct",
        "claimed_value": "1.08",
        "verified": true
    },
    {
        "claim_key": "thesis",
        "cited_table": "judgment_tool_calls",
        "cited_row_id": 2,
        "cited_field": "runnerPctBps",
        "claimed_value": "4194",
        "verified": true
    },
    {
        "claim_key": "thesis",
        "cited_table": "judgment_tool_calls",
        "cited_row_id": 2,
        "cited_field": "medianMultipleBps",
        "claimed_value": "15574",
        "verified": true
    },
    {
        "claim_key": "riskCalls[0]",
        "cited_table": "token_risks",
        "cited_row_id": 220991,
        "cited_field": "riskReasons",
        "claimed_value": "Contract source is not verified",
        "verified": true
    },
    {
        "claim_key": "riskCalls[1]",
        "cited_table": "token_holder_snapshots",
        "cited_row_id": 289595,
        "cited_field": "largestHolderPctBps",
        "claimed_value": "6251",
        "verified": true
    },
    {
        "claim_key": "riskCalls[1]",
        "cited_table": "token_holder_snapshots",
        "cited_row_id": 289595,
        "cited_field": "adjustedTop10PctBps",
        "claimed_value": "6105",
        "verified": true
    },
    {
        "claim_key": "riskCalls[2]",
        "cited_table": "pool_snapshots",
        "cited_row_id": 29779293,
        "cited_field": "priceUsd",
        "claimed_value": "0.000023445964401367",
        "verified": true
    },
    {
        "claim_key": "riskCalls[2]",
        "cited_table": "pool_snapshots",
        "cited_row_id": 30043753,
        "cited_field": "priceUsd",
        "claimed_value": "0.000013143426646191",
        "verified": true
    },
    {
        "claim_key": "disconfirming[0]",
        "cited_table": "trade_simulations",
        "cited_row_id": 220991,
        "cited_field": "sellStatus",
        "claimed_value": "PASS",
        "verified": true
    },
    {
        "claim_key": "disconfirming[0]",
        "cited_table": "trade_simulations",
        "cited_row_id": 220991,
        "cited_field": "buyStatus",
        "claimed_value": "PASS",
        "verified": true
    },
    {
        "claim_key": "disconfirming[1]",
        "cited_table": "pool_activity_snapshots",
        "cited_row_id": 4927800,
        "cited_field": "uniqueBuyers1h",
        "claimed_value": "64",
        "verified": true
    },
    {
        "claim_key": "disconfirming[1]",
        "cited_table": "pool_activity_snapshots",
        "cited_row_id": 4927800,
        "cited_field": "buyCount20m",
        "claimed_value": "67",
        "verified": true
    }
]
```
