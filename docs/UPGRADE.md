1. Back up the database and save the current image before replacing project files:

cd /opt/grade-portal
docker compose exec -T app node scripts/backup.js /backups
docker image tag grade-portal:local grade-portal:rollback-YYYYMMDD

Replace YYYYMMDD with today’s date. Copy the backup off the server as well.

2. Copy the updated project files into /opt/grade-portal from your development machine or source repository. Keep the server’s backups directory. Don’t copy database files or replace Docker volumes.

3. Check the Compose configuration, rebuild, and restart:

docker compose config --quiet
docker compose build --pull app
docker compose up -d
docker compose ps
docker compose logs --tail=100 app caddy

Test login and grade viewing from an allowed school device. The app container will be recreated, which may cause a short interruption.

If the app update fails, restore the previous image and restart:

docker image tag grade-portal:rollback-YYYYMMDD grade-portal:local
docker compose up -d app

If an update also changed the database, restoring the old app image alone may not be enough; you may need to restore the pre-update database backup using the procedure in the deployment README (/C:/myWorkingProjects/grade-portal/README.md). The current app has no versioned database migration system, so treat schema changes as a separate, carefully tested upgrade.

Avoid docker compose down -v and docker volume prune: those can delete persistent data. If you change the Caddy image version, update its pinned version in compose.yaml and pull it as part of the upgrade.