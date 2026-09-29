# Artifact: a delivered GREEN alert (production, 2026-07-23)

> Research artifact only. It is not financial or investment advice. It does
> not recommend a token or promise a result.

One row from `alerts_sent`, extracted verbatim from the production database
(final backup, 2026-07-27). This is the newest delivered GREEN alert. The
token ("Dividend District") had score 81 at send time; `first-alert` means
this token had never alerted at any tier before.

`alerts_sent` stores no recipient data: Telegram chat ids live in the
separate `telegram_subscriptions` table, which is not exported here.
Addresses are public on-chain data.

```json
{
    "id": 231,
    "chain_id": 4663,
    "token_address": "0xcfCb8C4D274F26B7dE67fE63984B08586ebAAcf4",
    "pool_address": "0xD53FcccbFa3cd56BDc459840243f9E63645ca4AB",
    "alert_level": "GREEN",
    "score": 81,
    "sent_at": "2026-07-23T04:32:20.163604+00:00",
    "reason": "first-alert",
    "transport": "telegram",
    "delivered": true
}
```

Column notes:

- `alert_level`: stoplight tier (`RED` early watch, `YELLOW` research,
  `GREEN` go). Escalation-only per token; `reason` records why this send
  happened (first alert, level increase, or cooldown re-send).
- `transport` / `delivered`: this row went out over the real Telegram
  transport and delivery succeeded.
- The alert text itself is rendered at send time by `packages/alerts`
  (`format.ts`) from the same snapshot rows the score used; it is not
  duplicated into this table.
