'use strict';
// Usage: node scripts/reset-teacher-password.js <username>
// issues a one-time temporary password, signs the teacher out everywhere, and forces a password change.
const { openDb } = require('../src/db');
const A = require('../src/auth');

(async () => {
  const [username] = process.argv.slice(2);
  if (!username) {
    console.error('Usage: node scripts/reset-teacher-password.js <username>');
    process.exit(1);
  }
  const db = await openDb({ connectionString: process.env.DATABASE_URL || undefined });
  try {
    const u = await db.one("SELECT id, username, full_name, active FROM users WHERE role = 'teacher' AND username = $1", [username]);
    if (!u) { console.error('No instructor with that username.'); process.exitCode = 1; return; }
    const pw = A.tempPassword(16);
    await db.tx(async q => {
      await q.query('UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2', [await A.hashPassword(pw), u.id]);
      await q.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
      await q.query("INSERT INTO audit_log (user_id, action, detail, ip) VALUES (NULL, 'teacher_password_reset', $1, NULL)", [u.username]);
    });
    console.log(`\nInstructor password reset.\n  Username: ${u.username}\n  Name: ${u.full_name}${u.active ? '' : ' (account disabled)'}\n  Temporary password: ${pw}\n\nAll their sessions were signed out. They must choose a new password at next sign-in.\n`);
  } finally {
    await db.close();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
