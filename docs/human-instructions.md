# Historical Operator Guide

Plain-language guide to the July 2026 trial. This document records the
operator workflow used during that period. The live worker is paused.

**Research and engineering documentation only.** Nothing here is financial,
investment, legal, or tax advice. It is not a recommendation or solicitation.
Independently assess all token and operational risk.

Deep detail lives in `docs/execution-methodology.md` (private) and `DEPLOY.md`;
this file is the "what do I actually do" version.

Last updated: 2026-07-23 (2026-07-20 model rebuild: GREEN score ≥ 80,
$10k–$100k watch band with a $15k–$40k go zone; analytics dashboard added).

## What this system does

It watches every new token pool on Robinhood Chain. It measures price,
liquidity, buyers, holders, and contract safety. It messages Telegram when a
token enters the $10k–$100k watch band and the $15k–$40k research-priority
zone. **It never trades. You decide everything.**

## The messages you'll see

| Message | What it means | What you do |
|---|---|---|
| 🔴 RED alert | Early watch: seen and tracked, too early to act | Glance. Maybe open the chart. No rush. |
| 🟡 YELLOW alert | Research candidate: passed all safety gates, score ≥ 65 | Research now. This is the intended research queue. |
| 🟢 GREEN alert | Highest-priority research: score ≥ 80 | Research promptly. Do not treat this as a trade instruction. |
| 🔬 Research brief | AI summary of the evidence, ~30s after YELLOW/GREEN | Read it as a head start. It cites real data (citations machine-verified) but is advisory only. |
| 📊 Winners retro | A token just hit ≥5x sustained — did we catch it? | Read the tier line (see below). Takes 30 seconds. |
| ⚠️ Dead-man page (ops chat) | The scanner itself is down or stale | See DEPLOY.md troubleshooting. This is the only message that means "fix infrastructure". |

Notes on alerts:
- Stoplight logic (since 2026-07-11): red = stop (not yet), yellow = get
  ready (research), green = go. Old alerts in your chat history used the
  previous names (YELLOW→now RED, ORANGE→now YELLOW, RED→now GREEN).
- The header is just the color dot + token name (since 2026-07-12); tap the
  `CA:` address to copy it; the Chart link opens dexscreener.
- A token re-alerts at the same level only if its score improved by 10+
  points after the 30-min cooldown. An upgrade (RED→YELLOW→GREEN) always
  fires immediately.
- 🔴 pages only for exceptional early-watch candidates (score ≥ 70,
  `ALERT_MIN_SCORE_RED`, since 2026-07-12) — most tokens now page once, at
  🟡, instead of 🔴 then 🟡 twenty minutes apart. Quieter REDs are still
  tracked; an upgrade to 🟡 always delivers.
- Copycat waves (several tokens launched with the SAME name within hours —
  e.g. four "Robin World" contracts in 11 seconds) now page once: the first
  delivered name wins, and a same-named sibling only pages again if it
  reaches a HIGHER tier (`ALERT_DUPLICATE_NAME_COOLDOWN_MS`, default 6h).
- A token gets ONE research brief per 24h unless it escalates a level —
  no more repeat briefs for a token camping in the band
  (`JUDGMENT_REBRIEF_COOLDOWN_MS`).
- Silence is normal and good. No alerts = nothing qualified. No winners
  digest = no big winner appeared.

Reading a winners-retro line:
- `CAUGHT` — we alerted it before/while it ran. Good.
- `LEAKED T2 no-trusted-quote` — it launched without a WETH/USDG pool; we
  structurally can't see those. If this repeats a lot, the fix is adding
  quote assets, not tuning the formula.
- `LEAKED T3/T4` — our pipeline was too slow to measure it in time.
  Infrastructure fix; tell the agent.
- `LEAKED T5 hard gate: <rule>` — a safety rule blocked it (this is often
  CORRECT — safety rules exist to block rugs that look like winners early).
- `LEAKED T6 below floor` — we saw it, scored it, and the score was too low.
  This is formula territory; feed it into the weekly review.

## Your check-in schedule

### As alerts arrive (whenever)
1. YELLOW/GREEN → do your research routine (see execution-methodology.md).
2. **Record what you decided, win or pass** — this powers the feedback loop:
   ```sh
   bun run decide -- --token=0x... --action=ENTERED --price=... --size=...
   bun run decide -- --token=0x... --action=PASSED --reason="thin exit"
   ```
   (Buys/sells from your registered wallet are auto-detected; `decide` is
   mainly for PASSED reasons and intent.)

### Daily (~1 minute)
- Glance at any winners-retro digests that arrived. Note the tier but do NOT
  change anything based on a single day — one winner is an anecdote.
- No dead-man page = the system is healthy. Nothing else to check.

### Weekly (~15 minutes, pick a fixed day)
```sh
ssh <server>          # address in docs/ops-private.md (untracked)
cd /opt/launch-radar
docker compose exec -T worker bun run retro:winners        # where winners leaked
docker compose exec -T worker bun run feedback             # you vs. the system
```
- Find the MOST-REPEATED leak tier across the week.
- T1–T4 dominant → tell the agent to fix coverage/latency (safe, do freely).
- T5/T6 dominant → open at most ONE formula investigation (see below).
- Also skim `feedback`: did you pass on things that survived (adjust your
  research), or enter things the system flagged risky (trust the gates)?
- For a visual read on trends (score-vs-outcome precision, launch cadence,
  recent alerts), run `bun run dashboard` and open http://127.0.0.1:4600
  (read-only, local, no auth; point DATABASE_URL at any Postgres with
  pipeline data).
- Ask the agent whether any deferred trigger has fired (V4 ingestion,
  project-evidence checks, canonical USDC, uptime heartbeat, off-site
  backups) — see docs/current-status.md's Next list.

### Every 2–3 weeks (~30 minutes)
```sh
docker compose exec -T worker bun run calibrate            # features vs. realized outcomes
```
- With a few weeks of labels, this shows which measured features actually
  separated winners from losers. This is when threshold changes become
  honest. Before that, resist tuning.

### Monthly (~5 minutes)
- Check server disk: `ssh <server> "df -h / && docker system df"`.
- Confirm backups exist: `ls -lh /opt/launch-radar/backups/ | tail -3`.
- Update the system: `cd /opt/launch-radar && git pull && docker compose up -d --build`.
- Note: external uptime heartbeat and off-site backup copy are both
  queued resilience items (see docs/current-status.md); the heartbeat is
  blocked on you supplying a healthchecks.io ping URL — hand it to the
  agent when ready.

## Changing a formula threshold (the rules)

Never change a threshold the same day you notice a pattern. Required inputs
(you supply these; the agent implements):

1. The feature list you'll examine, written down BEFORE looking at the week's
   data.
2. A mechanism: WHY would this feature separate winners, in market terms?
3. Counterfactual numbers from `calibrate`: at the proposed threshold, how
   many winners caught AND how many losers admitted?
4. The pattern must hold on the FOLLOWING week's winners (out-of-time test).
5. The change gets a dated entry in `docs/scoring-model.md` with before/after.

## Settings you might actually want to change

Edit `/opt/launch-radar/.env` on the server, then `docker compose up -d worker`.

| Setting | Default | Meaning |
|---|---|---|
| `ALERT_MIN_SCORE` | 80 | Historical production delivery floor. The historical in-sample estimate is not a validated performance result. |
| `ALERT_MIN_SCORE_RED` | 75 | Extra floor for 🔴 only (max with the global floor; inert while the global floor is 80). |
| `ALERT_REALERT_MIN_SCORE_DELTA` | 10 | Points a token must improve to re-alert at the same level. |
| `ALERT_DUPLICATE_NAME_COOLDOWN_MS` | 21600000 (6h) | One page per token NAME per window (copycat waves); a higher tier still pages. 0 = off. |
| `ALERT_COOLDOWN_MS` | 1800000 (30m) | Minimum gap between same-token re-alerts. |
| `JUDGMENT_MIN_ALERT_LEVEL` | YELLOW | Set RED to get AI briefs on early-watch alerts too (costs pennies). |
| `JUDGMENT_REBRIEF_COOLDOWN_MS` | 86400000 (24h) | One brief per token per this window unless the level escalates. 0 = brief every alert. |
| `WINNERS_MIN_MULTIPLE_BPS` | 50000 (5x) | What counts as a "winner" in the retro. |
| `WINNERS_MIN_EXIT_LIQUIDITY_USD` | 15000 | Winner must have been exitable for this much. |

## When something looks wrong

- **Repeated identical alerts** → shouldn't happen anymore; if it does, tell
  the agent (include the token address).
- **No alerts for 24h+ during an active market** → run the weekly commands
  early; if `retro:winners` shows CAUGHT=0 with many T5/T6 leaks, the gates
  may be too tight for current conditions.
- **Dead-man page** → DEPLOY.md §7 troubleshooting, in order.
- **Anything confusing** → ask the agent; include the exact Telegram message
  or log line.
