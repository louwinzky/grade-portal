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
- `subjects(owner_id, code, title, term, section, rel_prelim, rel_midterm, rel_prefinal, rel_finals, last_import_at)`:
  the `rel_*` booleans are the release switches; `last_import_at` drives the Overview/header import note.
- `enrollments(subject_id, student_id, prelim, midterm, prefinal, finals, final_pct, final_gp, remark)`:
  `NUMERIC` grades with `CHECK` ranges; `final_pct` is instructor-view only. `UNIQUE (subject_id, student_id)`.
- `sessions(token_hash, user_id, expires_at)`, `audit_log(...)`, `schema_migrations(name)`.

Schema changes are numbered SQL files in `migrations/`, applied once in order at startup under a PostgreSQL
advisory lock (safe if two instances start together). Migrations `001`–`004` are applied in this preview; to change
the schema, add the next numbered file and never edit an applied file.

## Request flows
- **Publish**: gradebook "Registrar Report (CSV)" -> instructor page -> `POST /subjects/:id/import`
  (`dryRun` first) -> validate every row -> upsert in one transaction (`INSERT ... ON CONFLICT DO UPDATE`).
- **Student view**: `GET /api/student/grades` -> rows for `req.user.studentId` only -> unreleased periods are
  nulled **on the server** -> Final Grade only when all four periods are released.
- **Accounts**: the instructor creates accounts for enrolled students; random temporary passwords are returned
  once; until changed, a session can only call `/me`, `/change-password`, `/logout`. Owners can also create/reset/
  disable/promote instructors individually or bulk-create them from CSV (`POST /api/admin/teachers/bulk`), with all
  rows validated before any write and bad rows reported by line. Release helpers (`PUT /subjects/:id/releases`)
  are just batched updates of the same `rel_*` flags and are audited like individual switches.

## Authorization rules
1. No session -> 401. Wrong role -> 403.
2. Students: one endpoint, own record, no identifiers accepted from the client.
3. Teachers: every subject/student lookup is scoped by `owner_id`; other teachers' objects return 404.

## Student dashboard
Top bar (menu, wordmark, account avatar), left sidebar (Grades, FAQs, Privacy Notice), term selector, and one
card per subject with an accessible period `<table>` and a Final Grade pill. The header shows a **Term Avg /
Overall Avg**: a simple average of released Final Grades (dropped subjects excluded), with a **How averages work**
link to the FAQ. It is intentionally *not* labelled GWA, because a true GWA is unit-weighted across every subject,
and this portal only knows the subjects published here. The sidebar carries the signed-in identity, the top bar is
shared with the instructor page, and **Print** uses a print stylesheet that hides navigation and controls.

## Instructor security additions
Instructor accounts can optionally add a verified email and TOTP second factor. `users` holds `email`,
`email_verified_at`, `totp_secret`, and pending-enrollment columns; `recovery_codes`, `password_resets`, and
`login_challenges` are separate tables (`migrations/005_auth_security.sql`). A correct password for a 2FA-enabled
instructor creates a 10-minute `login_challenges` row instead of a session; `/api/login/2fa` accepts either a
current TOTP code (±1 step) or one unused backup code, then creates the normal session. Recovery links are hashed
with SHA-256, last 30 minutes, are single-use, and still issue a 2FA challenge after the password is changed.
SMTP is generic and configured from `PORTAL_BASE_URL`/`SMTP_*`/`MAIL_FROM`; an SMS adapter exists but is disabled
by default. Rate limits for these flows are in memory, like the login limiter.

## Known limitations / next steps
- **Student names are global by Student ID.** A re-import updates the stored name. Fine with one instructor;
  with several, restrict renames or add a registrar-owned student table.
- **Lockout counters live in memory** (reset on restart; per process). Move them to the database if you ever run
  more than one app container.
- **The app's database role owns the schema** (it runs migrations). A stricter setup uses a separate migration
  role and gives the runtime role only DML rights.
- **Students have no self-service password reset** by design; a teacher resets student accounts. Student lockout
  also lets someone lock a classmate's account for 15 minutes.
- **Instructor email/SMS/2FA rate limits are per-process memory**, so a multi-replica deployment would need a shared
  store. This deployment uses one app container.
- **SMS is not enabled**; the adapter is a seam for a future, privacy-approved gateway.
- **Docker files were not run in a Docker daemon during development** (none was available); the application and
  its PostgreSQL behaviour were tested against a real PostgreSQL server, the container configuration was reviewed
  but not executed. Expect to confirm `docker compose up` on your host.
- **Not independently security-reviewed.** `docs/SECURITY-REVIEW.md` is the handoff packet, not a review result.
