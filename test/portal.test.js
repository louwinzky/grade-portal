'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const A = require('../src/auth');

// These tests need a real PostgreSQL. Point TEST_DATABASE_URL at a throwaway database, e.g.
//   docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5433/postgres npm test
// Each run creates (and drops) its own schema, so it never touches real data.
const DB_URL = process.env.TEST_DATABASE_URL;
const needDb = DB_URL ? {} : { skip: 'set TEST_DATABASE_URL to run the database tests' };

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'docs', 'sample-registrar-report.csv'), 'utf8');

async function boot() {
  const schema = 't_' + crypto.randomBytes(6).toString('hex');
  const app = await createApp({ connectionString: DB_URL, schema });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = app.locals.db;
  const addTeacher = async (username, name) => (await db.one("INSERT INTO users (username,password_hash,role,full_name,must_change_password) VALUES ($1,$2,'teacher',$3,false) RETURNING id", [username, await A.hashPassword('teacher-pass-1234'), name])).id;

  // tiny client with its own cookie jar
  const client = () => {
    let cookie = '';
    const call = async (method, url, body, extra = {}) => {
      const headers = { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra };
      const res = await fetch(base + url, { method, headers, redirect: 'manual', body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const sc = res.headers.getSetCookie?.() || [];
      if (sc.length) { const c = sc[0].split(';')[0]; cookie = c.endsWith('=') ? '' : c; }
      let json = null; try { json = await res.clone().json(); } catch {}
      return { status: res.status, json, headers: res.headers, setCookie: sc };
    };
    return { get: (u, h) => call('GET', u, null, h), post: (u, b, h) => call('POST', u, b, h), put: (u, b) => call('PUT', u, b) };
  };
  const close = async () => { await new Promise(r => server.close(r)); await db.close(); await db.dropSchema(); };
  return { app, db, server, base, addTeacher, client, close, schema };
}

test('end-to-end: publish, release, student view, isolation', needDb, async (t) => {
  const S = await boot();
  t.after(S.close);
  await S.addTeacher('prof', 'Prof. Reyes');
  await S.addTeacher('other', 'Other Teacher');

  const teacher = S.client();
  const login = await teacher.post('/api/login', { username: 'prof', password: 'teacher-pass-1234' });
  assert.equal(login.status, 200);
  assert.equal(login.json.role, 'teacher');
  assert.match(login.setCookie[0], /HttpOnly/);
  assert.match(login.setCookie[0], /SameSite=Strict/);

  // subject + import (dry run first)
  const sub = await teacher.post('/api/admin/subjects', { code: 'NET02', title: 'Networking 2', term: '2025-2026 1st Term', section: 'BSIT 3A' });
  assert.equal(sub.status, 201);
  const id = sub.json.id;

  // subject details can be edited; grades stay import-only
  const edited = await teacher.put(`/api/admin/subjects/${id}`, { code: 'NET02', title: 'Networking 2 — Updated', term: '2025-2026 1st Term', section: 'BSIT 3A' });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.title, 'Networking 2 — Updated');
  assert.equal((await teacher.get(`/api/admin/subjects/${id}`)).json.title, 'Networking 2 — Updated');
  assert.equal((await teacher.put(`/api/admin/subjects/${id}`, { code: 'X', title: '', term: 'T' })).status, 400);
  const dup = await teacher.post('/api/admin/subjects', { code: 'CS101', title: 'CS', term: 'T2', section: 'S' });
  assert.equal(dup.status, 201);
  assert.equal((await teacher.put(`/api/admin/subjects/${id}`, { code: 'CS101', title: 'CS', term: 'T2', section: 'S' })).status, 409);
  await S.db.query('DELETE FROM subjects WHERE id = $1', [dup.json.id]);
  const dry = await teacher.post(`/api/admin/subjects/${id}/import`, { csv: SAMPLE, dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.rows, 3);
  assert.equal(dry.json.skipped.length, 1);
  assert.match(dry.json.skipped[0].reason, /Student ID/);
  assert.equal((await S.db.one('SELECT COUNT(*)::int AS c FROM students')).c, 0, 'dry run must not save anything');
  const real = await teacher.post(`/api/admin/subjects/${id}/import`, { csv: SAMPLE });
  assert.equal(real.json.newStudents, 3);
  // re-import is an update, not a duplicate
  const again = await teacher.post(`/api/admin/subjects/${id}/import`, { csv: SAMPLE });
  assert.equal(again.json.newStudents, 0);
  assert.equal(again.json.updatedEnrollments, 3);

  // accounts
  const acc = await teacher.post(`/api/admin/subjects/${id}/accounts`, {});
  assert.equal(acc.json.created.length, 3);
  const juan = acc.json.created.find(c => c.studentNo === '2023-0101');
  const maria = acc.json.created.find(c => c.studentNo === '2023-0102');
  assert.ok(juan.tempPassword.length >= 10);
  assert.equal((await teacher.post(`/api/admin/subjects/${id}/accounts`, {})).json.created.length, 0, 'no duplicate accounts');
  assert.ok(!JSON.stringify(await S.db.all('SELECT password_hash FROM users')).includes(juan.tempPassword), 'passwords are stored hashed');

  // student: forced password change before anything else
  const stu = S.client();
  assert.equal((await stu.post('/api/login', { username: '2023-0101', password: juan.tempPassword })).json.mustChangePassword, true);
  const blocked = await stu.get('/api/student/grades');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error, 'password_change_required');
  assert.equal((await stu.post('/api/change-password', { current: juan.tempPassword, next: 'short' })).status, 400);
  assert.equal((await stu.post('/api/change-password', { current: juan.tempPassword, next: 'my-own-password-77' })).status, 200);

  // nothing released yet: no grade values reach the student
  let g = await stu.get('/api/student/grades');
  assert.equal(g.status, 200);
  assert.equal(g.json.subjects.length, 1);
  assert.ok(g.json.subjects[0].periods.every(p => p.value === null && p.released === false));
  assert.equal(g.json.subjects[0].finalGrade, null);
  assert.ok(!Number.isNaN(Date.parse(g.json.subjects[0].updatedAt)), 'card shows a last-updated date');

  // release Prelim only
  await teacher.put(`/api/admin/subjects/${id}/releases`, { prelim: true });
  g = await stu.get('/api/student/grades');
  const p = g.json.subjects[0].periods;
  assert.equal(p[0].value, 85);
  assert.equal(p[1].value, null);
  assert.equal(g.json.subjects[0].finalVisible, false);
  assert.ok(!JSON.stringify(g.json).includes('"84"') && !JSON.stringify(g.json).includes(':84'), 'midterm value must not leak');

  // release everything: final grade appears, but never anyone else's data
  await teacher.put(`/api/admin/subjects/${id}/releases`, { midterm: true, prefinal: true, finals: true });
  g = await stu.get('/api/student/grades');
  assert.equal(g.json.subjects[0].finalVisible, true);
  assert.equal(g.json.subjects[0].finalGrade, 2);
  assert.equal(g.json.subjects[0].remark, 'Passed');
  const raw = JSON.stringify(g.json);
  assert.ok(!raw.includes('Santos') && !raw.includes('Reyes, Pedro') && !raw.includes('finalPct'));

  // the other student sees only their own record
  const mar = S.client();
  await mar.post('/api/login', { username: '2023-0102', password: maria.tempPassword });
  await mar.post('/api/change-password', { current: maria.tempPassword, next: 'maria-secure-pass-1' });
  const mg = await mar.get('/api/student/grades');
  assert.equal(mg.json.student.fullName, 'Santos, Maria');
  assert.equal(mg.json.subjects[0].finalGrade, 1.25);

  // students cannot reach teacher functions or pages
  assert.equal((await stu.get('/api/admin/subjects')).status, 403);
  assert.equal((await stu.post(`/api/admin/subjects/${id}/import`, { csv: SAMPLE })).status, 403);
  const pageAttempt = await stu.get('/admin');
  assert.equal(pageAttempt.status, 302);
  assert.equal(pageAttempt.headers.get('location'), '/login');

  // another teacher cannot touch this subject
  const other = S.client();
  await other.post('/api/login', { username: 'other', password: 'teacher-pass-1234' });
  assert.equal((await other.get(`/api/admin/subjects/${id}`)).status, 404);
  assert.equal((await other.put(`/api/admin/subjects/${id}/releases`, { prelim: false })).status, 404);
  assert.equal((await other.put(`/api/admin/subjects/${id}`, { code: 'HACK', title: 'Hack', term: 'T' })).status, 404);
  assert.equal((await other.post(`/api/admin/students/${(await S.db.one('SELECT id FROM students LIMIT 1')).id}/reset-password`)).status, 404);

  // password reset kills the old session and forces a change again
  const juanStudentId = (await S.db.one("SELECT id FROM students WHERE student_no = '2023-0101'")).id;
  const reset = await teacher.post(`/api/admin/students/${juanStudentId}/reset-password`, {});
  assert.equal(reset.status, 200);
  assert.equal((await stu.get('/api/student/grades')).status, 401, 'old session must be invalid after reset');
  const fresh = S.client();
  assert.equal((await fresh.post('/api/login', { username: '2023-0101', password: reset.json.tempPassword })).json.mustChangePassword, true);

  // logout invalidates the session
  assert.equal((await mar.post('/api/logout', {})).status, 200);
  assert.equal((await mar.get('/api/me')).status, 401);
});

test('login hardening, CSRF and headers', needDb, async (t) => {
  const S = await boot();
  t.after(S.close);
  await S.addTeacher('prof', 'Prof');

  // same message for wrong password and unknown user
  const c = S.client();
  const wrong = await c.post('/api/login', { username: 'prof', password: 'nope' });
  const unknown = await c.post('/api/login', { username: 'ghost', password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, unknown.json);

  // lockout after repeated failures, even with the right password afterwards
  for (let i = 0; i < 5; i++) await c.post('/api/login', { username: 'prof', password: 'bad' + i });
  const locked = await c.post('/api/login', { username: 'prof', password: 'teacher-pass-1234' });
  assert.equal(locked.status, 429);

  // cross-site and non-JSON writes are rejected
  const s2 = S.client();
  await s2.post('/api/login', { username: 'ghost', password: 'x' });
  const evil = await S.client().post('/api/login', { username: 'a', password: 'b' }, { Origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
  const form = await fetch(S.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=a&password=b' });
  assert.equal(form.status, 415);

  // security headers + no caching of API data
  const res = await fetch(S.base + '/login');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal((await fetch(S.base + '/api/me')).headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(S.base + '/api/student/grades')).status, 401);
});

test('importer rejects bad files cleanly', async (t) => {
  const { parseRegistrarCsv } = require('../src/csv');
  assert.throws(() => parseRegistrarCsv('a,b\n1,2'), /header row/);
  const bad = 'Student Name,Student ID,Prelim (%),Midterm (%),Pre-final (%),Final (%),Grade Point,Remark\nX Y,2024-1,101,80,80,80,2.00,Passed\nZ Z,2024-2,80,80,80,80,9,Passed\nA B,2024-3,80,80,80,80,2.00,Passed';
  const r = parseRegistrarCsv(bad);
  assert.equal(r.rows.length, 1);
  assert.equal(r.errors.length, 2);
});

test('postgres: case-insensitive usernames, uniqueness, health check, idempotent migrations', needDb, async (t) => {
  const S = await boot();
  t.after(S.close);
  await S.addTeacher('Prof', 'Prof');
  // login works regardless of the case typed
  assert.equal((await S.client().post('/api/login', { username: 'PROF', password: 'teacher-pass-1234' })).status, 200);
  // ...and two usernames differing only by case cannot both exist
  await assert.rejects(() => S.addTeacher('prof', 'Dup'), e => e.code === '23505');

  assert.deepEqual((await (await fetch(S.base + '/healthz')).json()), { ok: true });

  // starting a second app on the same schema must not re-run migrations or fail
  const again = await createApp({ connectionString: DB_URL, schema: S.schema });
  const applied = await again.locals.db.all('SELECT name FROM schema_migrations');
  assert.equal(applied.length, 1);
  await again.locals.db.close();

  // the database itself rejects impossible grades, independent of application checks
  const t1 = await S.db.one("SELECT id FROM users LIMIT 1");
  const sub = await S.db.one("INSERT INTO subjects (owner_id, code, title, term) VALUES ($1,'X1','X','T') RETURNING id", [t1.id]);
  const st = await S.db.one("INSERT INTO students (student_no, full_name) VALUES ('9','Z') RETURNING id");
  await assert.rejects(() => S.db.query('INSERT INTO enrollments (subject_id, student_id, prelim) VALUES ($1,$2,150)', [sub.id, st.id]), e => e.code === '23514');
});
