# Shared by backup.sh and restore.sh (sourced, not run).

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! docker compose version >/dev/null 2>&1; then
  echo "error: 'docker compose' is not available. See docs/runbook.md." >&2
  exit 1
fi

# docker compose reads .env itself, but these scripts need GITLIB_BACKUPS before compose runs. The real
# environment wins over .env, like compose. (.env is parsed, not sourced, so odd characters in a token are safe.)
dotenv() {
  [[ -f .env ]] || return 0
  grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

BACKUPS_DIR="${GITLIB_BACKUPS:-$(dotenv GITLIB_BACKUPS)}"
BACKUPS_DIR="${BACKUPS_DIR:-./backups}"

# Create it as ourselves: if Docker creates a missing bind-mount directory it is owned by root on Linux,
# and the container user could not write to it.
mkdir -p "$BACKUPS_DIR"
