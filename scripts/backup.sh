#!/usr/bin/env bash
#
# Dumps the launch_radar database from the running `postgres` compose
# service, gzips it, and keeps only the newest RETENTION_COUNT dumps. Safe
# to run repeatedly and safe from cron (no interactive prompts, no
# dependency on a terminal).
#
# Count-based (not age-based) retention: each dump is a full restore point
# and dump size tracks DB growth, so "keep N newest" bounds disk use no
# matter how large dumps get. Age-based pruning filled the disk on
# 2026-07-19 (14 days x ~3G/dump on a 38G disk; postgres PANICed).
#
# Usage (run from the repo root, where docker-compose.yml lives):
#   ./scripts/backup.sh
#
# Cron (see DEPLOY.md):
#   17 3 * * * cd /opt/launch-radar && ./scripts/backup.sh >> /var/log/launch-radar-backup.log 2>&1
set -euo pipefail
umask 077

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BACKUP_DIR="backups"
RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-2}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="${BACKUP_DIR}/launch_radar_${STAMP}.sql.gz"

mkdir -p -m 700 "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

echo "[backup] dumping launch_radar -> ${OUT_FILE}"
docker compose exec -T postgres pg_dump -U postgres launch_radar | gzip > "${OUT_FILE}"

echo "[backup] keeping the ${RETENTION_COUNT} newest dumps"
ls -t "${BACKUP_DIR}"/launch_radar_*.sql.gz 2>/dev/null | tail -n "+$((RETENTION_COUNT + 1))" | xargs -r rm -v

echo "[backup] done: $(du -h "${OUT_FILE}" | cut -f1)"
