#!/bin/sh
# Restore a backup made by backup-db.sh.  Usage: ./scripts/restore-db.sh backups/portal-XXXX.dump
# This REPLACES the current database contents. The app is stopped during the restore.
set -eu
[ $# -eq 1 ] && [ -f "$1" ] || { echo "Usage: $0 <backup.dump>" >&2; exit 1; }
cd "$(dirname "$0")/.."
printf "Replace the live database with %s? Type 'yes' to continue: " "$1"; read ans; [ "$ans" = "yes" ] || exit 1
docker compose stop app
docker compose exec -T db pg_restore -U portal -d portal --clean --if-exists --no-owner < "$1"
docker compose start app
echo "Restored from $1"
