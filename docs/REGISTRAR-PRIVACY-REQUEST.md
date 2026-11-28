# Registrar / data privacy sign-off request (draft)

**To:** Registrar / Data Privacy Officer  
**From:** Grade Portal maintainer  
**Subject:** Approval request to publish summary grades through an internal Grade Portal

We request approval before using the Grade Portal with real student data. This draft is a request, not an approval.

## What the portal is

- A read-only internal web portal for students to see **published summary grades only**.
- The separate gradebook system remains the source of truth. Grades enter the portal only when an instructor uploads
  that gradebook's **Registrar Report (CSV)**. This published-copy model has been technically confirmed by the
  maintainer; no live gradebook database is exposed to the portal.
- Students sign in with their Student ID and see only their own record. Unreleased periods are removed server-side
  and never sent to the browser.
- Instructors release each period explicitly (Prelim, Midterm, Pre Finals, Finals). The Final Grade appears only
  after all four are released.
- Stored fields are limited to student number/name and four period percentages, final percentage, final grade
  (1.00–5.00), and remark. No quiz/exam scores are stored.

## Access and controls

- Accounts: student accounts are created/reset by instructors; instructor accounts are managed by an Owner/operator.
- Usernames and student numbers are case-sensitive; passwords are at least 8 characters and hashed.
- Optional instructor two-factor sign-in with authenticator app and one-time backup codes.
- Instructor-only password recovery by verified email; SMS delivery is disabled by default.
- HTTPS through Caddy, session cookies are HttpOnly/SameSite=Strict/Secure, database is not exposed outside Docker's
  internal network, and administrative actions are audited.
- Backups are database dumps plus VM backups; they must be stored off-host and access-restricted.

## Questions for approval

1. Does the registrar permit publishing summary grades outside the official gradebook system through this portal?
2. Is the published-copy/import-only model acceptable as the control boundary?
3. Should any period or final grade be withheld by policy even when an instructor releases it?
4. What retention period applies to the portal's copy, and when should records be deleted?
5. Does the Privacy Notice page in the student portal need changes? (See `public/assets/student.js`.)
6. Who may access server backups, and where must they be stored?

## Requested outcome

Please record approval or required changes below.

Approved for first production use: ☐ Yes  ☐ Yes with conditions  ☐ No

Conditions / required changes: _________________________________________________________

Retention period: __________  Reviewer name/office: ____________________  Date: __________
