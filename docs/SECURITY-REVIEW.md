# Independent security review packet

Status: **prepared for review — not an independent review and not a sign-off.**

Use `SECURITY-REVIEW-REQUEST.md` as the ready-to-send request; use this file as the reviewer's scope/evidence packet.

This document gives an external reviewer the scope, evidence and open questions needed to review Grade Portal
before real student data is published. The reviewer should be someone other than the implementer/owner.

## Scope to review

- `src/app.js`, `src/auth.js`, `src/api.js`, `src/security-api.js`, `src/totp.js`, `src/mailer.js`, `src/sms.js`
- `public/assets/*.js`, `public/login.html`, `public/reset-password.html`, `public/verify-email.html`
- `migrations/001_init.sql` through `005_auth_security.sql`
- `docker-compose.yml`, `Dockerfile`, `Caddyfile`, `.env.example`
- Test evidence: `npm test` (12 tests) and `npm audit` (0 vulnerabilities at time of writing)

## Threat model / claims to verify

| Claim | Where to look |
|---|---|
| Students can only see their own released grades; unreleased values never leave the server | `src/api.js` (`/api/student/grades`), `test/portal.test.js` |
| Student accounts cannot self-reset; only an instructor can | `src/api.js` (`/api/admin/students/:id/reset-password`) |
| Instructors are confined to their own subjects; only Owners manage accounts | `src/api.js` `needOwner`/`ownerId` scoping |
| Password policy is 8+ characters for all roles; temporary passwords force a change | `src/auth.js`, `src/app.js` |
| Sessions are `HttpOnly`/`SameSite=Strict`/`Secure` behind HTTPS, hashed at rest, and revoked on reset/disable | `src/auth.js`, `docker-compose.yml` |
| TOTP enrollment requires a valid code; backup codes are single-use; disabling/regenerating requires the password | `src/security-api.js`, `test/security.test.js` |
| Recovery links are 30-minute, single-use, hashed, do not enumerate accounts, and re-challenge 2FA users | `src/security-api.js`, `test/security.test.js` |
| Write APIs reject cross-origin/non-JSON requests; CSP blocks inline/external scripts | `src/app.js` |
| Database is not published; app container is non-root, read-only, capabilities dropped | `docker-compose.yml`, `Dockerfile` |
| Backup/restore works and backups are off-host | `scripts/backup-db.sh`, `scripts/restore-db.sh` |

## Findings requested from reviewer

1. Authentication/session edge cases: challenge reuse, token expiry, logout during challenge, email change while 2FA on.
2. Authorization: any teacher route that trusts client-supplied IDs, Owner self-lockout paths.
3. Recovery abuse: rate-limit bypass via username casing/proxy headers, email injection, SMTP misconfiguration.
4. Data exposure: logs, error messages, audit details, JSON payloads, browser storage, print/PDF output.
5. Deployment: Caddy TLS, reverse-proxy headers, container hardening, volume permissions, backup secrets.
6. Privacy: retention and registrar authority to publish grades outside the official system.

## Out of scope / accepted for this deployment

- Multi-replica deployments (in-memory rate limits).
- Enabled SMS delivery; only a disabled adapter exists.
- Protection from an attacker who already has shell/host or backup access.
- Client-side password manager/browser autofill behaviour beyond standard autocomplete attributes.

## Evidence to attach before review

- Commit hash reviewed (owner commits; AI must not commit without authorization).
- `npm test` output against a throwaway PostgreSQL schema.
- `npm audit` output.
- Deployment host/VM/DNS/TLS details and a restore drill result.
- Registrar/privacy sign-off reference number or minute.
