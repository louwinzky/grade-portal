# Architecture

## Goal
Let students with an account see their own Prelim, Midterm, Pre Finals, Finals and Final Grade for the
subject(s) the instructor handles (starting with Networking 2), in a layout modelled on a school student dashboard.

## Key decision: publish a copy, don't expose the gradebook
The existing gradebook is a single HTML file that keeps data in the instructor's browser. It stays that way.
The portal is a separate small server that receives a **published summary** of it:

- **Instructor-controlled**: nothing reaches students until the instructor imports it and releases each period.
- **Minimal data**: only the four period percentages, the final grade (1.00-5.00) and the remark. Quiz/task/exam
  scores, absences and attendance never leave the gradebook.
- **No coupling**: the portal can be rebuilt, moved or switched off without touching the gradebook.
- **Idempotent updates**: re-importing the same CSV updates grades in place (keyed by Student ID).

The cost: grade changes need a re-import. That is deliberate; it is also the review step.

## Deployment (Docker Compose on a Proxmox VM)
```
 Student / Instructor browser (LAN)
        | HTTPS :443
 +------+---------------------------- Docker host (Proxmox VM) -----------------------+
 |  caddy  (TLS via internal CA, reverse proxy)          network: frontend            |
 |     | http                                                                         |
 |  app    (Node 22 / Express; non-root, read-only fs)   networks: frontend + backend |
 |     | PostgreSQL protocol                                                          |
 |  db     (postgres:17, volume pgdata, never published) network: backend (internal)  |
 +------------------------------------------------------------------------------------+
```
`backend` is an internal Docker network: the database has no route to or from the outside world.
Only Caddy publishes ports (80 redirects, 443 serves).

## Code layout
`src/app.js` middleware + auth routes + pages, `src/api.js` student and instructor routes, `src/auth.js`
hashing/sessions/lockout, `src/csv.js` importer, `src/db.js` pool, transactions and migration runner,
`migrations/*.sql` schema, `public/` static pages (no CDN, no inline scripts).

## Data model (PostgreSQL)
- `students(student_no, full_name)`: identity from the school's Student ID; unique and case-sensitive.
- `users(username, password_hash, role teacher|student, student_id UNIQUE, must_change_password, is_owner, active)`:
  at most one account per student; usernames are unique and case-sensitive (`Prof` ≠ `prof`).
- `subjects(owner_id, code, title, term, section, rel_prelim, rel_midterm, rel_prefinal, rel_finals)`:
  the `rel_*` booleans are the release switches.
- `enrollments(subject_id, student_id, prelim, midterm, prefinal, finals, final_pct, final_gp, remark)`:
  `NUMERIC` grades with `CHECK` ranges; `final_pct` is instructor-view only. `UNIQUE (subject_id, student_id)`.
- `sessions(token_hash, user_id, expires_at)`, `audit_log(...)`, `schema_migrations(name)`.

Schema changes are numbered SQL files in `migrations/`, applied once in order at startup under a PostgreSQL
advisory lock (safe if two instances start together). To change the schema, add `002_*.sql`; never edit an applied file.

## Request flows
- **Publish**: gradebook "Registrar Report (CSV)" -> instructor page -> `POST /subjects/:id/import`
  (`dryRun` first) -> validate every row -> upsert in one transaction (`INSERT ... ON CONFLICT DO UPDATE`).
- **Student view**: `GET /api/student/grades` -> rows for `req.user.studentId` only -> unreleased periods are
  nulled **on the server** -> Final Grade only when all four periods are released.
- **Accounts**: the instructor creates accounts for enrolled students; random temporary passwords are returned
  once; until changed, a session can only call `/me`, `/change-password`, `/logout`.

## Authorization rules
1. No session -> 401. Wrong role -> 403.
2. Students: one endpoint, own record, no identifiers accepted from the client.
3. Teachers: every subject/student lookup is scoped by `owner_id`; other teachers' objects return 404.

## Student dashboard
Top bar (menu, wordmark, account avatar), left sidebar (Grades, FAQs, Privacy Notice), term selector, and one
card per subject with the period band and a Final Grade pill. The header shows a **Term Avg / Overall Avg**:
a simple average of released Final Grades (dropped subjects excluded). It is intentionally *not* labelled GWA,
because a true GWA is unit-weighted across every subject, and this portal only knows the subjects published here.

## Known limitations / next steps
- **Student names are global by Student ID.** A re-import updates the stored name. Fine with one instructor;
  with several, restrict renames or add a registrar-owned student table.
- **Lockout counters live in memory** (reset on restart; per process). Move them to the database if you ever run
  more than one app container.
- **The app's database role owns the schema** (it runs migrations). A stricter setup uses a separate migration
  role and gives the runtime role only DML rights.
- **No self-service password reset.** The instructor resets it (by design, avoids email infrastructure).
  Lockout also lets someone lock a classmate's account for 15 minutes.
- **No 2FA** for instructor accounts. Worth adding if the portal holds more than one subject's grades.
- **Docker files were not run in a Docker daemon during development** (none was available); the application and
  its PostgreSQL behaviour were tested against a real PostgreSQL server, the container configuration was reviewed
  but not executed. Expect to confirm `docker compose up` on your host.
- **Not independently security-reviewed.**
