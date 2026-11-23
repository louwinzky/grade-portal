#!/bin/sh
# Logical backup of the portal database (portable to any PostgreSQL). Run from the project folder on the Docker host.
# Cron example (02:00 nightly):  0 2 * * * cd /opt/grade-portal && ./scripts/backup-db.sh >> backups/backup.log 2>&1
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
file="backups/portal-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db pg_dump -U portal -d portal --format=custom > "$file.tmp"
[ -s "$file.tmp" ] || { echo "Backup is empty, aborting" >&2; rm -f "$file.tmp"; exit 1; }
mv "$file.tmp" "$file"
ls -1t backups/portal-*.dump | tail -n +31 | xargs -r rm --     # keep the newest 30
echo "Backup written: $file ($(wc -c < "$file") bytes)"
