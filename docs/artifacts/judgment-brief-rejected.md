# Artifact: two briefs rejected for fabricated citations (never delivered)

> Research artifact only. It is not financial or investment advice. It does
> not recommend a token or promise a result.

Both rows are from production (2026-07-21, prompt v2). In both cases the
citation checker re-fetched every cited row after generation, found
load-bearing claims that did not verify, persisted the brief as
`REJECTED_FABRICATED_CITATION`, and skipped delivery. Rejected briefs are
kept forever: the fabrication rate is a queryable number, not an estimate.

## Case 1: paraphrased evidence (value mismatch)

Brief 138 ("Not In Labor Force", recommendation RESEARCH at 70%
confidence, 12 citations, 9 verified). The model cited a real row and a
real field, but reformatted the value: it wrote the risk reasons with a
`; ` separator where the stored value uses `,`. Verification is an exact
value comparison, so a paraphrase is indistinguishable from an invented
value and the whole brief is rejected. A confident RESEARCH call that
never reached anyone.

```json
{
    "id": 138,
    "token_address": "0x511fDc5CE0edb9c4020C05eE8860dA45B29c5084",
    "pool_address": "0xD6aE4732064323D27a7aa3E61bA09459A7354dD0",
    "as_of": "2026-07-21T00:40:31.099+00:00",
    "prompt_name": "research-brief",
    "prompt_version": 2,
    "model": "gpt-4.1-mini",
    "status": "REJECTED_FABRICATED_CITATION",
    "recommendation": "RESEARCH",
    "confidence_bps": 7000,
    "citations_total": 12,
    "citations_verified": 9,
    "delivery": "SKIPPED"
}
```

The three failing pointers, claimed vs actual:

```json
[
    {
        "claim_key": "thesis",
        "cited_table": "token_risks",
        "cited_row_id": 221981,
        "cited_field": "riskReasons",
        "claimed_value": "Contract source is not verified; Owner-controlled administrative functions present",
        "actual_value": "Contract source is not verified,Owner-controlled administrative functions present",
        "verified": false
    },
    {
        "claim_key": "riskCalls[0]",
        "cited_table": "token_risks",
        "cited_row_id": 221981,
        "cited_field": "riskReasons",
        "claimed_value": "Contract source is not verified; Owner-controlled administrative functions present",
        "actual_value": "Contract source is not verified,Owner-controlled administrative functions present",
        "verified": false
    },
    {
        "claim_key": "riskCalls[2]",
        "cited_table": "token_risks",
        "cited_row_id": 221981,
        "cited_field": "riskReasons",
        "claimed_value": "Contract source is not verified; Owner-controlled administrative functions present",
        "actual_value": "Contract source is not verified,Owner-controlled administrative functions present",
        "verified": false
    }
]
```

## Case 2: citing outside the allow-list (unresolvable pointer)

Brief 168 ("Dividend Garden", WATCH at 70%, 16 citations, 7 verified).
The model cited `functions.judgment_tool_calls`, its own tool-call
transcript, instead of an allow-listed append-only history table.
Citations only resolve against the fixed table allow-list, so
`actual_value` is null: the pointer itself is invalid, regardless of the
number it carries.

```json
{
    "id": 168,
    "token_address": "0xd74E37C3b6D4a26DbaB57eb238068b337592456E",
    "status": "REJECTED_FABRICATED_CITATION",
    "recommendation": "WATCH",
    "confidence_bps": 7000,
    "citations_total": 16,
    "citations_verified": 7,
    "delivery": "SKIPPED"
}
```

All nine failing pointers:

```json
[
    {
        "claim_key": "thesis",
        "cited_table": "functions.judgment_tool_calls",
        "cited_row_id": 4,
        "cited_field": "peakQuoteLiquidityUsd",
        "claimed_value": "6839.408768200482113483",
        "actual_value": null,
        "verified": false
    },
    {
        "claim_key": "thesis",
        "cited_table": "functions.judgment_tool_calls",
        "cited_row_id": 4,
        "cited_field": "currentQuoteLiquidityUsd",
        "claimed_value": "5288.344962327895678566",
        "actual_value": null,
        "verified": false
    },
    {
        "claim_key": "thesis",
        "cited_table": "functions.judgment_tool_calls",
        "cited_row_id": 3,
        "cited_field": "tokenCount",
        "claimed_value": "0",
        "actual_value": null,
        "verified": false
    },
    {
        "claim_key": "thesis",
        "cited_table": "functions.judgment_tool_calls",
        "cited_row_id": 2,
        "cited_field": "diedPct",
        "claimed_value": "0",
        "actual_value": null,
        "verified": false
    },
    {
        "claim_key": "thesis",
        "cited_table": "functions.judgment_tool_calls",
        "cited_row_id": 2,
        "cited_field": "runnerPctBps",
        "claimed_value": "3750",
        "actual_value": null,
        "verified": false
    },
    {
        "claim_key": "riskCalls[0]",
        "cited_table": "functions.judgment_tool_calls",
        "cited_row_id": 4,
        "cited_field": "drawdownFromPeakBps",
        "claimed_value": "2268",
        "actual_value": null,
        "verified": false
    },
    {
        "claim_key": "riskCalls[2]",
        "cited_table": "functions.judgment_tool_calls",
        "cited_row_id": 3,
        "cited_field": "tokenCount",
        "claimed_value": "0",
        "actual_value": null,
        "verified": false
    },
    {
        "claim_key": "disconfirming[0]",
        "cited_table": "functions.judgment_tool_calls",
        "cited_row_id": 4,
        "cited_field": "collapsed",
        "claimed_value": "false",
        "actual_value": null,
        "verified": false
    },
    {
        "claim_key": "disconfirming[0]",
        "cited_table": "functions.judgment_tool_calls",
        "cited_row_id": 4,
        "cited_field": "currentQuoteLiquidityUsd",
        "claimed_value": "5288.344962327895678566",
        "actual_value": null,
        "verified": false
    }
]
```
