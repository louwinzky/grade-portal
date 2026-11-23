'use strict';
// Usage: node scripts/create-teacher.js <username> "<Full Name>"
// Prints a one-time temporary password; the teacher must change it at first sign-in.
const { openDb, isUniqueViolation } = require('../src/db');
const A = require('../src/auth');
(async () => {
  const [username, ...rest] = process.argv.slice(2);
  const fullName = rest.join(' ').trim();
  if (!username || !fullName) { console.error('Usage: node scripts/create-teacher.js <username> "<Full Name>"'); process.exit(1); }
  const db = await openDb({ connectionString: process.env.DATABASE_URL || undefined });
  const pw = A.tempPassword(16);
  try {
    await db.query("INSERT INTO users (username, password_hash, role, full_name, must_change_password) VALUES ($1,$2,'teacher',$3,true)", [username, await A.hashPassword(pw), fullName]);
  } catch (e) { console.error(isUniqueViolation(e) ? 'That username already exists.' : e.message); await db.close(); process.exit(1); }
  await db.close();
  console.log(`\nTeacher account created.\n  Username: ${username}\n  Temporary password: ${pw}\n\nSign in at /login, you will be asked to choose a new password (12+ characters).\n`);
})().catch(e => { console.error(e.message); process.exit(1); });
