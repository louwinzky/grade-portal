## Step 1 - Transfer the ZIP file to Ubuntu Server
On your Windows computer, open PowerShell and run:

If your ZIP has a different filename, adjust the command accordingly
scp "C:\myWorkingProjects\file-filename.zip" bizkit@192.168.40.100:/home/bizkit/

## Step 2 - Prepare the deployment directory
Back on Ubuntu, execute:

sudo mkdir -p /opt/grade-portal
sudo chown bizkit:docker /opt/grade-portal

mkdir -p /opt/grade-portal/backups

Extract the ZIP:
unzip /home/bizkit/grade-portal.zip -d /opt/grade-portal/

Depending on the ZIP structure, the files may end up inside a nested grade-portal directory. We'll check that before proceeding.

## Step 3 – Inspect the extracted files
Run:
find /opt/grade-portal -maxdepth 3 -type f | sort

Also run: 
ls -lah /opt/grade-portal

if there is directory-layout issue: the project is currently nested one level deeper than our intended deployment location. 
Move the project files into the deployment directory

Run:
sudo cp -a /opt/grade-portal/grade-portal/. /opt/grade-portal/

Then correct ownership and permissions:
sudo chown -R bizkit:docker /opt/grade-portal
sudo chmod -R u=rwX,g=rX,o= /opt/grade-portal

## Verify the project structure:
test -f /opt/grade-portal/Dockerfile && echo "Dockerfile: OK"
test -f /opt/grade-portal/compose.yaml && echo "Compose: OK"
test -f /opt/grade-portal/Caddyfile && echo "Caddyfile: OK"
test -f /opt/grade-portal/server.js && echo "Server: OK"
test -f /opt/grade-portal/package-lock.json && echo "Package lock: OK"

## Inspect the deployment configuration
Before building, let's check the environment template and Compose configuration.
Run:
cd /opt/grade-portal

echo "===== ENVIRONMENT TEMPLATE ====="
cat .env.example

echo "===== COMPOSE CONFIGURATION ====="
cat docker-compose.yml

echo "===== CADDY CONFIGURATION ====="
cat Caddyfile

## Validate the Compose configuration:
docker compose config --quiet
echo "Compose exit code: $?"

A result of 0 means Compose accepted the configuration.

## Configure instructor recovery email (before go-live)
Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD`, `PORTAL_HOST`, and `PORTAL_BASE_URL` (the exact HTTPS URL
instructors use). For recovery email, also set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and
`MAIL_FROM`. If any of these are blank, the portal still starts but no verification/reset email is sent. SMS stays
disabled unless a provider is explicitly approved and `SMS_GATEWAY`/`SMS_GATEWAY_MODULE` are set. Never commit `.env`.

## Updating CaddyFile, permits access from Management, Staff, and Student Wi-Fi networks.
cd /opt/grade-portal
nano Caddyfile

## Inspection
Run:
cd /opt/grade-portal

echo "===== DOCKERFILE ====="
cat Dockerfile

echo "===== PACKAGE CONFIGURATION ====="
cat package.json

echo "===== EXPRESS PROXY AND LISTEN SETTINGS ====="
grep -nE "trust proxy|process.env.HOST|process.env.PORT|listen\\(" server.js src/*.js

echo "===== FILE OWNERSHIP ====="
ls -ld . data backups 2>/dev/null

echo "===== COMPOSE VALIDATION ====="
docker compose config --quiet
echo "Compose exit code: $?"

## Gives the Application Permission to write backups
sudo chown 10001:10001 /opt/grade-portal/backups
sudo chmod 750 /opt/grade-portal/backups

## Verify database shutdown handling
Run:
cd /opt/grade-portal
grep -nE 'app\.locals|locals\.db|return app|module\.exports' src/app.js
>> confirm that app.locals.db.close() in server.js actually refers to the database connection created by createApp().

## Prepare backup directory permissions
Run:
sudo chown 10001:10001 /opt/grade-portal/backups
sudo chmod 750 /opt/grade-portal/backups

ls -ld /opt/grade-portal/backups
> Expected ownership: 10001 10001
>> This allows the application container's non-root user to write backups to the host directory.

## After thos checks, build the image
> Step 1 — Build the Grade Portal image
Run:
cd /opt/grade-portal
docker compose build --no-cache app
> This will:
1. Download the Node.js 24 build image if needed.
2. Install the application dependencies.
3. Compile the native better-sqlite3 SQLite module.
4. Create the production Grade Portal image.
> Wait for the build to finish. A successful build should end with something similar to:
>> Successfully built ...
>> Successfully tagged grade-portal:local

> Step 2 — Verify SQLite and container security
Run these two commands:
1. Test the SQLite native module
docker run --rm --entrypoint node grade-portal:local -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); console.log('SQLite version:',db.prepare('SELECT sqlite_version() AS version').get().version); console.log('SQLite test:',db.prepare('SELECT 1 AS result').get().result); db.close();"
>> Expected result: a SQLite version number and SQLite test: 1.

2. Verify the configured container user
docker image inspect grade-portal:local --format 'Container user: {{.Config.User}}'
>> Expected result: Container user: 10001:10001

3. Step 3 — Run the automated application tests
>> We'll use a temporary Node.js container so we can run the tests without installing Node.js on your Ubuntu host or changing your production image.
Run this from /opt/grade-portal:

docker run --rm \
  -v "$PWD:/src:ro" \
  -w /tmp \
  node:24-bookworm-slim \
  bash -lc '
    mkdir grade-portal &&
    cp -a /src/. grade-portal/ &&
    cd grade-portal &&
    apt-get update -qq &&
    apt-get install -y -qq --no-install-recommends python3 make g++ &&
    npm ci --omit=dev --ignore-scripts=false &&
    npm test
  '

This will:
- Copy the project into the temporary container.
- Install the dependencies needed by the test environment.
- Run the existing node --test test suite.
- Leave your production project directory unchanged.

>> If test are Passed
## Start the Grade Portal services
Run: 
cd /opt/grade-portal
docker compose up -d

>> This starts two containers:
- app — Express Grade Portal application, accessible internally on port 3000.
- caddy — HTTPS reverse proxy, listening on 192.168.40.100:443.

## Verify deployment
After Compose finishes, run:
1. docker compose ps
2. docker compose logs --tail=50 app caddy

What we want to see:
Component	Expected status
app	        Up (healthy)
caddy	    Up
Express	    Listening on port 3000
Caddy	    No configuration or certificate errors

Also verify that HTTPS is listening on the intended server IP:
sudo ss -lntp | grep ':443'

## If CaddyFile's config permission is denied
>> log like this: open /etc/caddy/Caddyfile: permission denied

>>Fix
Step 1 — Check the current Caddyfile permissions
Run: 
ls -l /opt/grade-portal/Caddyfile
> Also check the parent directory:
ls -ld /opt/grade-portal 

Step 2 — Allow Caddy to read the configuration
Run: 
sudo chmod 755 /opt/grade-portal
sudo chmod 644 /opt/grade-portal/Caddyfile
>> This makes the configuration readable by the Caddy container while leaving it read-only inside the container.

Step 3 — Restart Caddy
docker compose up -d --force-recreate caddy

## Verify HTTPS from the Ubuntu VM 
>> Root Certificate

First Run: 
curl -k -I https://grades.school.lan --resolve grades.school.lan:443:192.168.40.100

Expected result: HTTP/1.1 200 OK
>> A 200 OK confirms that HTTPS reaches the Grade Portal login page.

Next, verify the certificate:

docker compose exec caddy \
  cat /data/caddy/pki/authorities/local/root.crt \
  > /tmp/grades-school-root.crt

Then inspect it:

openssl x509 -in /tmp/grades-school-root.crt \
  -noout -subject -issuer -dates

## Verify the hostname resolution
On Ubuntu, run:
getent hosts grades.school.lan
>> it should return: 192.168.40.100 grades.school.lan
If it does not:
>> Configure the hostname in your school DNS (Windows Server DNS or your chosen DNS server).

1. Add the Grade Portal DNS record (On Windows Server: Acting as Active Directory DNS Server)

>>Open: Server Manager → Tools → DNS

Create the correct DNS zone
In DNS Manager:
1. Right-click Forward Lookup Zones.
2. Select New Zone.
3. Choose Primary Zone (store in Active Directory if available).
4. Enter this zone name:

Then: 
1. Expand your server.
2. Expand Forward Lookup Zones.
3. Select ccdilab.lan
4. Right-click the zone and select New Host (A or AAAA).
5. Enter the following:
Field:	Value
Name:	grades
Fully qualified domain name:	grades.ccdilab.local
IP address:	192.168.40.100

2. Verify DNS
>> In Windows Server, run: 
nslookup grades.school.lan

>> Expected result: 
Name:    grades.school.lan
Address: 192.168.40.100

>> In Ubuntu Server run:
getent hosts grades.school.lan

>> It should return:
192.168.40.100 grades.school.lan

## Configure a DNS Host Override in pfSense (Firewall)
Services → DNS Resolver → General Settings
Find the Host Overrides section and click Add.
Field:	Value
Host:	grades
Domain:	school.lan
IP Address:	192.168.40.100
Description:	Grade Portal

> Test from Windows:
ipconfig /flushdns
nslookup grades.school.lan

> Expected result:
Server:  pfSense.ccdi.local
Address: 192.168.10.1
Name:    grades.school.lan
Address: 192.168.40.100

>Test HTTPS connectivity
Run in PowerShell:
Test-NetConnection grades.school.lan -Port 443

Result should be: TcpTestSucceeded : True


## Transfer the root certificate to Windows
open PowerShell and run:
scp bizkit@192.168.40.100:/tmp/grades-school-root.crt "$env:USERPROFILE\Downloads\grades-school-root.crt"

