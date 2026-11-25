'use strict';
// Usage: node scripts/create-teacher.js [--owner] <username> "<Full Name>"
// Prints a one-time temporary password; the teacher must change it at first sign-in.
// The first instructor created always becomes the Owner; --owner grants it to others too.
const { openDb, isUniqueViolation } = require('../src/db');
const A = require('../src/auth');

(async () => {
  const args = process.argv.slice(2);
  const wantOwner = args.includes('--owner');
  const [username, ...rest] = args.filter(a => a !== '--owner');
  const fullName = rest.join(' ').trim();
  if (!username || !fullName) {
    console.error('Usage: node scripts/create-teacher.js [--owner] <username> "<Full Name>"');
    process.exit(1);
  }
  const db = await openDb({ connectionString: process.env.DATABASE_URL || undefined });
  const pw = A.tempPassword(16);
  let isOwner = false;
  try {
    const owners = await db.one("SELECT COUNT(*)::int AS c FROM users WHERE role = 'teacher' AND is_owner");
    isOwner = wantOwner || owners.c === 0;
    await db.query(
      "INSERT INTO users (username, password_hash, role, full_name, is_owner, must_change_password) VALUES ($1,$2,'teacher',$3,$4,true)",
      [username, await A.hashPassword(pw), fullName, isOwner]);
    await db.query("INSERT INTO audit_log (user_id, action, detail, ip) VALUES (NULL, 'teacher_created', $1, NULL)",
      [`${username} (${fullName}) via CLI${isOwner ? ' [owner]' : ''}`]);
  } catch (e) {
    console.error(isUniqueViolation(e) ? 'That username already exists.' : e.message);
    await db.close();
    process.exit(1);
  }
  await db.close();
  console.log(`\nInstructor account created.\n  Username: ${username}\n  Name: ${fullName}\n  Access: ${isOwner ? 'Owner' : 'Instructor'}\n  Temporary password: ${pw}\n\nSign in at /login; you will be asked to choose a new password (at least 8 characters).\n`);
})().catch(e => { console.error(e.message); process.exit(1); });
