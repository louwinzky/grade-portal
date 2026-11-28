Local preview (native Node + Docker Postgres on port 5433)
cd "C:\myWorkingProjects\grade-portal"

$env:PGHOST='127.0.0.1'
$env:PGPORT='5433'
$env:PGUSER='portal'
$env:PGPASSWORD='devpass'
$env:PGDATABASE='portal'
$env:PORT='3000'
$env:HOST='127.0.0.1'
$env:COOKIE_SECURE='false'

node server.js
Then open http://localhost:3000.
If the database container isn't running:
docker start grade-portal-db
docker ps

or

$env:DATABASE_URL = "postgres://portal:devpass@127.0.0.1:5433/portal"
node "C:\myWorkingProjects\grade-portal\server.js"