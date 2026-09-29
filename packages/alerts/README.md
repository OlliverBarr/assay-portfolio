# @assay/alerts

Alert formatting, deduplication, and delivery.

- `formatAlert` — pure: candidate features + score + level → the multi-line
  Telegram-HTML message (glyph-only header — `🟡 Token (SYM)`, no level
  word — with the escaped token name,
  tap-to-copy `<code>` contract address, FDV/liquidity/buyers, score, top-3
  positive and risk reasons, dexscreener chart link; the pool address is
  never displayed). `escapeHtml` is exported — the transport sends
  `parse_mode: "HTML"`, so every sender must escape dynamic strings.
- `evaluateAlert` — pure emit decision against the last persisted alert:
  GRAY never emits; scores below the configured `minScore` never emit, and
  RED-level alerts additionally require `minScoreRed` (effective RED floor
  is the max of the two; the candidate is still scored and persisted
  upstream); a delivered same-named sibling token (copycat launch waves)
  suppresses anything at or below its level; first alert emits; level
  escalation emits immediately; same/lower level re-emits only after the
  cooldown AND a material score improvement (`reAlertMinScoreDelta`). Every
  decision carries a machine-stable reason.
- Transports — `createTelegramTransport` (Bot API `sendMessage`, throws
  `AlertDeliveryError` on non-OK) and `createDryRunTransport` (logs instead
  of sending; used whenever Telegram credentials are absent).

Fan-out to self-service subscriptions lives in the worker
(`apps/worker/src/fanout-transport.ts`), wrapping the primary transport from
this package. This package stays transport-only: no database access, no
scoring logic.
