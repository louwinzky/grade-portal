# Independent security review request (draft)

**To:** School IT Officer / designated security reviewer  
**From:** Grade Portal maintainer  
**Subject:** Request for independent review before first production use of Grade Portal

We are preparing to deploy a small internal Grade Portal that publishes summary grades from our separate gradebook
system. Before real student data is used, we request an independent review of the application and deployment
configuration. This draft is not a review result; it is the request and scope.

## What to review

1. **Source and configuration** at the reviewed commit:
   - `src/app.js`, `src/auth.js`, `src/api.js`, `src/security-api.js`, `src/totp.js`, `src/mailer.js`, `src/sms.js`
   - `public/assets/*.js`, `public/login.html`, `public/reset-password.html`, `public/verify-email.html`
   - `migrations/001_init.sql` through `005_auth_security.sql`
   - `docker-compose.yml`, `Dockerfile`, `Caddyfile`, `.env.example`
   - `docs/SECURITY-REVIEW.md` (threat model and evidence checklist)
2. **Evidence already gathered by the maintainer** (not independent):
   - `npm test` — 12 tests passing against a throwaway PostgreSQL schema
   - `npm audit` — 0 reported vulnerabilities at time of writing
   - Headless browser checks of login, password change, forgot-password view, Account security dialog,
     instructor/student scrolling, and mobile layout
3. **Deployment target details** (to be supplied before final review): Proxmox host/VM, DNS name, TLS approach,
   firewall rules, backup location, SMTP sender/gateway.

## Specific questions for the reviewer

- Can a student obtain any unreleased grade or another student's record through any API, page, log, or printout?
- Can an instructor access a subject or account outside their ownership? Can an Owner be locked out by their own action?
- Are session, recovery, TOTP challenge, and backup-code flows resistant to reuse, expiry bypass, CSRF, and
  account enumeration?
- Are SMTP configuration and error paths free of credential leakage or header injection?
- Are the container, reverse proxy, and backup arrangements appropriate for personal grade data?
- Are there any high or critical findings that must be fixed before go-live?

## What is explicitly out of scope

- Multi-replica deployments (rate limits are in-memory; this deployment uses one app container).
- Enabled SMS delivery (adapter present but disabled).
- An attacker who already has shell/host or backup access.

## Requested outcome

Please record a short review result with: reviewer name/date, commit hash reviewed, findings by severity, required
fixes before go-live, and a clear "approved for first production use / not approved" conclusion.

Reviewer: ____________________  Date: __________  Commit: __________

Result: ☐ Approved  ☐ Approved with conditions  ☐ Not approved

Notes / findings: ____________________________________________________________________
