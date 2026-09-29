# Project Rules

1. Never treat missing, errored, unknown, or stale risk data as a pass.

2. Never use token symbol or name as proof of contract identity. Trusted assets must be recognized by verified chain and contract address.

3. Never use JavaScript floating-point numbers for raw on-chain balances, supplies, prices, or liquidity calculations.

4. Every valuation must state its method. Early-token valuation is `estimated FDV`, not verified market capitalization.

5. Eligibility and opportunity score are separate. A high score cannot override an eligibility failure.

6. Every score and rejection must retain machine-readable component values and human-readable reasons.

7. The block cursor advances only after the entire processed range has been committed successfully.

8. Event ingestion and database writes must be idempotent and restart-safe.

9. Use direct on-chain events for primary pool discovery. Third-party market APIs are enrichment sources, not the authoritative launch feed.

10. No autonomous trade execution, private-key handling, or transaction signing without an explicit project-scope change.

11. LLM output may summarize and classify but may not authoritatively determine contract safety, tradeability, numerical valuation, or eligibility.

12. Do not introduce infrastructure, abstractions, or additional chains that are not required for the current milestone.

13. Update tests whenever calculation, eligibility, scoring, or risk behavior changes.

14. Record source block numbers and timestamps for market, risk, and simulation data.

15. Never silently swallow an RPC, decoding, calculation, simulation, or persistence failure.
