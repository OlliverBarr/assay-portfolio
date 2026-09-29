# syntax=docker/dockerfile:1
#
# Runtime image for the Launch Radar worker (and, via a different `command:`
# in docker-compose.yml, the dead-man switch — same image, same install).
#
# `bun.lock` is tracked in git: a fresh server clone always has it, so the
# image installs with `--frozen-lockfile`, giving a build that is
# reproducible from the committed lockfile alone.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
WORKDIR /app

# Manifests first, so the install layer only invalidates when a package.json
# changes — not on every source edit. Docker's wildcard COPY (e.g.
# `apps/*/package.json apps/`) flattens same-named files across matched
# directories and silently overwrites all but one, so each workspace member
# is copied explicitly instead.
COPY package.json ./
COPY bun.lock ./
COPY apps/worker/package.json apps/worker/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/activity/package.json packages/activity/package.json
COPY packages/alerts/package.json packages/alerts/package.json
COPY packages/chain/package.json packages/chain/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/discovery/package.json packages/discovery/package.json
COPY packages/enrichment/package.json packages/enrichment/package.json
COPY packages/holders/package.json packages/holders/package.json
COPY packages/judgment/package.json packages/judgment/package.json
COPY packages/risk-engine/package.json packages/risk-engine/package.json
COPY packages/scoring/package.json packages/scoring/package.json

RUN bun install --frozen-lockfile

# Now the rest of the sources (see .dockerignore for exclusions).
COPY --chown=bun:bun . .

# oven/bun images ship a non-root `bun` user (uid 1000) out of the box.
USER bun

CMD ["bun", "apps/worker/src/main.ts"]
