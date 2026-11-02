#!/usr/bin/env bash
# Replace gitlib's data with a backup archive made by scripts/backup.sh (from this machine or another).
#
#   scripts/restore.sh backups/gitlib-backup-20261102T031500Z.tar.gz
#   scripts/restore.sh -y /mnt/nas/gitlib-backup-20261102T031500Z.tar.gz   # skip the confirmation
#
# The archive is verified first. The web app is stopped while the databases are swapped and started again
# afterwards (if it was running), which also rebuilds the search index. What was there before is saved as
# pre-restore-<timestamp>.tar.gz in the data volume (/data/backups), so a restore can be undone.
# See docs/runbook.md#backup-and-restore.
set -euo pipefail

ASSUME_YES=0
if [[ "${1:-}" == "-y" || "${1:-}" == "--yes" ]]; then
  ASSUME_YES=1
  shift
fi
if [[ $# -ne 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi

ARCHIVE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[[ -f "$ARCHIVE" ]] || { echo "error: $1 not found" >&2; exit 1; }

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

# The archive can live anywhere on the host; mount just that file into the one-off container.
# </dev/null: the container must not swallow the answer to the confirmation prompt below.
gitlib() {
  docker compose run --rm --no-deps -T -v "$ARCHIVE:/restore/backup.tar.gz:ro" gitlib "$@" </dev/null
}

echo "Checking $ARCHIVE ..."
gitlib backup verify /restore/backup.tar.gz

if [[ $ASSUME_YES -ne 1 ]]; then
  echo
  echo "This REPLACES the notes, descriptions, favorites, planning data and config.toml in the 'gitlib-data' volume."
  read -r -p "Continue? [y/N] " answer || answer=""
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "Aborted; nothing changed."; exit 1; }
fi

WAS_RUNNING=0
if docker compose ps --status running --services 2>/dev/null | grep -qx web; then
  WAS_RUNNING=1
  echo "Stopping the web app ..."
  docker compose stop web
fi

# Restart even if the restore fails: on failure the data is untouched, so the old state comes back up.
restart_web() {
  if [[ $WAS_RUNNING -eq 1 ]]; then
    echo "Starting the web app ..."
    docker compose up -d web
  fi
}
trap restart_web EXIT

gitlib backup restore /restore/backup.tar.gz --yes
