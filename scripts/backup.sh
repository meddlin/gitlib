#!/usr/bin/env bash
# Back up all gitlib data (config.toml, gitlib.db, planning.db) to $GITLIB_BACKUPS (default ./backups).
#
#   scripts/backup.sh            # writes gitlib-backup-<UTC timestamp>.tar.gz, keeps the newest 14
#   GITLIB_BACKUP_KEEP=30 scripts/backup.sh
#
# Safe to run while the app is up (SQLite snapshots), and from cron: it needs no terminal.
# See docs/runbook.md#backup-and-restore.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

KEEP="${GITLIB_BACKUP_KEEP:-14}"

# --no-deps: don't start Meilisearch just to take a backup. -T: no TTY, so cron works.
docker compose run --rm --no-deps -T gitlib backup create --keep "$KEEP"
