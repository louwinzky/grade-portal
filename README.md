# Grade Portal

A small, read-only portal where students sign in and see **only their own** grades for the subjects you publish:
Prelim, Midterm, Pre Finals, Finals and the Final Grade, laid out like a school student dashboard.
Your gradebook stays the source of truth; this server holds a published copy.

```
Gradebook --Registrar Report CSV--> Instructor page --> PostgreSQL --> Student dashboard
 (raw scores stay here)              (import + release)  (summary only)  (own grades only)
```

Stack: Node 22 + Express, PostgreSQL 17, Caddy (HTTPS), all in Docker Compose.

## Deploy on your Proxmox Docker host

1. **Copy the project** to the Docker host (e.g. `/opt/grade-portal`).
2. **Configure**:
   ```bash
   cp .env.example .env
   openssl rand -base64 24 | tr -d '/+='     # paste the result as POSTGRES_PASSWORD in .env
   # set PORTAL_HOST in .env to the name students will type, e.g. grades.school.lan
   ```
3. **Start**: `docker compose up -d --build`   (first start applies the database schema automatically)
4. **Create your instructor account** (prints a one-time password; you choose a new one at first sign-in).
   The first instructor becomes the **Owner**, who can manage accounts from the dashboard:
   ```bash
   docker compose exec app node scripts/create-teacher.js prof "Prof. Reyes"
   ```
5. **DNS**: point `PORTAL_HOST` at this host (router/DNS record). Open `https://<PORTAL_HOST>/login`.
6. **HTTPS trust**: Caddy issues certificates from its own internal CA, so devices show a warning until they trust it.
   Export the root certificate and install it on student devices (or distribute it by your school's device policy):
   ```bash
   docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./portal-root-ca.crt
   ```
   Personal phones make this awkward. If your school has a real domain, use a normal certificate instead
   (replace `tls internal` in `Caddyfile`). Keep the `caddy_data` volume either way.

### Using it

1. **New subject** (e.g. Networking 2, school year & term, section). Pick the **School year** and **Term** from
   the dropdowns (an **Other** option accepts a custom term). The school year follows a **June–May academic
   calendar** and rolls forward automatically: previous, current and next year are offered, with the current
   June–May year selected by default (Jan–May still uses the year that began last June). Change any of these later
   with **Edit subject**; that does not move students or grades. Use the **School year & term** selector in the
   sidebar to filter subjects, and the **Search subjects** box to filter by title, code, section or term. With
   **All terms** selected, subjects are grouped under their term headings; **New subject** starts with the
   selected term filled in. Wrong subject? **Delete** removes it and its imported grades after confirmation —
   student accounts and other subjects are not affected.
2. In the gradebook, open the section → **Registrar Report (CSV)**. Upload it → **Check file** → **Import**.
   Every student needs a **Student ID** in the gradebook; rows without one are skipped and listed.
3. **Create accounts**: usernames are Student IDs, each student gets a one-time temporary password
   (shown once, downloadable as CSV). Hand them out privately. Students must choose their own at first sign-in.
4. Tick **Prelim / Midterm / Pre-Finals / Finals** when you want students to see each period.
   The Final Grade appears only after all four are released. Re-import any time to update grades.

`docs/sample-registrar-report.csv` is a real export from the gradebook you can try first.

## Instructor accounts

The **first instructor created becomes the Owner**. The Owner (and any other instructor they promote) sees an
**Instructors** item in the dashboard sidebar and can manage up to ~50 accounts there:

- **New instructor** — username, full name and optional Owner access. A random temporary password is generated
  and shown **once** (copy it or download the CSV before closing the dialog). They must choose their own password
  at first sign-in. Usernames are **case-sensitive** (`Prof` and `prof` are different accounts) and must be unique.
  Passwords must be at least 8 characters.
- **Reset password** — issues a new temporary password, signs the instructor out everywhere and forces another
  password change at next sign-in. Use this when they forget their password. **You cannot reset yourself here**:
  change your own password from the account menu (avatar → Change password). If you lose your own password, an
  operator must use the CLI command below.
- **Disable / Enable** — disabling immediately ends their sessions and blocks sign-in; their subjects and grades
  are kept. Re-enable to let them back in with their existing password.
- **Make owner / Remove owner** — owners can create and manage accounts. At least one active Owner is always kept;
  you cannot disable or demote yourself.

Instructors who are not Owners do not see the management page, and the API rejects them with `403`.

If nobody can sign in (e.g. the Owner is locked out), an operator with shell access can reset any instructor
from the host:

```bash
docker compose exec app node scripts/reset-teacher-password.js prof
```

It prints a one-time password, ends that instructor's sessions, forces a password change and writes an audit
entry. To create another instructor from the shell, use
`docker compose exec app node scripts/create-teacher.js [--owner] <username> "<Full Name>"`.

## Proxmox notes

- **Run Docker in a VM, not an LXC container.** Proxmox's own guidance is to run application containers in a
  QEMU VM; Docker inside LXC needs nesting and tends to break after updates. A Debian/Ubuntu VM with
  2 vCPU, 2 GB RAM and 20 GB disk is plenty for a class.
- **Backups, two layers:** (1) a scheduled Proxmox backup of the VM (Datacenter → Backup, to storage that is
  *not* on the same disk; Proxmox Backup Server if you have one); (2) the nightly database dump below, which
  restores on any PostgreSQL. Take a VM snapshot before upgrades.
- **Network/firewall:** put the VM where students can reach it, allow inbound 443 (and 80 for the redirect),
  and limit SSH to your admin machine. PostgreSQL is **not** published: it lives on an internal Docker network
  that only the app can reach.
- **Keep the clock correct** (NTP). Sessions and TLS depend on it.

## Operations

| Task | Command (run in the project folder) |
|---|---|
| Status / logs | `docker compose ps` · `docker compose logs -f app` |
| Update the app | replace files, then `docker compose up -d --build` (migrations apply on start) |
| **Backup** | `./scripts/backup-db.sh` → `backups/portal-*.dump` (keeps the newest 30) |
| Nightly backup (cron) | `0 2 * * * cd /opt/grade-portal && ./scripts/backup-db.sh >> backups/backup.log 2>&1` |
| **Restore** | `./scripts/restore-db.sh backups/portal-XXXX.dump` (asks for confirmation, stops the app during restore) |
| Reset a student's password | Instructor page → Students and accounts → Reset password |
| Reset an instructor's password | Instructor page → Instructors → Reset password (Owner), or `docker compose exec app node scripts/reset-teacher-password.js <username>` |
| Create / disable an instructor | Instructor page → Instructors (Owner only), or `scripts/create-teacher.js [--owner] <username> "<Full Name>"` |
| Stop everything | `docker compose down` (data stays in volumes; `down -v` would delete it) |

Copy `backups/` to another machine regularly. A backup that lives only on the same server is not a backup.
Test a restore once before you need it.

Notes: PostgreSQL's major version is pinned to 17; moving to a newer major needs a dump and restore.
Changing `POSTGRES_PASSWORD` in `.env` later does **not** change the password inside an existing database
(run `ALTER ROLE portal PASSWORD '...'` in `docker compose exec db psql -U portal` as well).

## Development and tests

```bash
npm install
docker run --rm -d --name pgtest -p 5433:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
export TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5433/postgres
npm test            # end-to-end, security, importer, and PostgreSQL-specific suites
```

Each test run creates and drops its own schema, so it never touches real data. Without `TEST_DATABASE_URL`
the database suites are skipped. To run the app outside Docker: set `PGHOST/PGUSER/PGPASSWORD/PGDATABASE`
(or `DATABASE_URL`), then `npm start`. Node does not hot-reload server code, so restart it after editing
`src/` or `server.js`. Static assets are cached for 1 hour in production (`NODE_ENV=production`, as in Docker)
but not cached locally, so a normal refresh is enough after frontend edits in local preview.

## What it protects against (and doesn't)

| Control | Where |
|---|---|
| Passwords hashed with scrypt; minimum 8 characters; temporary passwords random, single-use, must be changed at first sign-in | `src/auth.js` |
| Server-side release flags: unreleased grades are never sent to the browser | `src/api.js` |
| Students can only query their own record; the API accepts no student identifier | `src/api.js` |
| Teachers can only manage their own subjects; only Owners can manage instructor accounts | `src/api.js` |
| Session cookie `HttpOnly` + `SameSite=Strict` + `Secure`; tokens stored hashed; password change/reset ends other sessions | `src/auth.js` |
| Login lockout (5 failures / 15 min per account, 40 per IP); same error for unknown user and wrong password | `src/app.js` |
| Same-origin + JSON-only writes (CSRF); strict CSP, no inline scripts, no external assets | `src/app.js` |
| Parameterised SQL everywhere; database CHECK constraints reject impossible grades | `src/api.js`, `migrations/` |
| Containers: app runs as non-root, read-only filesystem, all capabilities dropped; database on an internal-only network | `docker-compose.yml` |
| Audit log of logins, imports, releases, account and password actions | `audit_log` table |

Not covered: two-factor sign-in for instructors, email/SMS password recovery (an Owner or an operator with shell
access must reset an instructor's password), protection from someone with access to the server or its backups,
and an independent security review.
Have your school IT or data privacy officer review this before students rely on it.

## Data privacy

Grades are personal information under the Philippine Data Privacy Act (RA 10173). Before going live: confirm
your department/registrar permits publishing grades outside the official system, review and adjust the
privacy notice in `public/assets/student.js` (the "Privacy Notice" page), restrict access to the server and
its backups, and decide how long records are kept. Only summary grades are stored here, never quiz/exam scores.

See `docs/ARCHITECTURE.md` for the design, data model and known limitations.
