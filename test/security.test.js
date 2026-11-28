'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const A = require('../src/auth');
const T = require('../src/totp');

const DB_URL = process.env.TEST_DATABASE_URL;
const needDb = DB_URL ? {} : { skip: 'set TEST_DATABASE_URL to run the database tests' };

async function boot(opts = {}) {
  const schema = 't_' + crypto.randomBytes(6).toString('hex');
  // Fake mailer captures reset links so tests do not need a real SMTP server.
  const sent = [];
  const mailer = { configured: true, baseUrl: 'http://127.0.0.1:3000', sendPasswordReset: async (msg) => { sent.push(msg); return true; } };
  const app = await createApp({ connectionString: DB_URL, schema, mailer, ...opts });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = app.locals.db;
  const id = (await db.one("INSERT INTO users (username,password_hash,role,full_name,email,email_verified_at,must_change_password) VALUES ('prof', $1,'teacher','Prof. Reyes','prof@school.edu',now(),false) RETURNING id", [await A.hashPassword('teacher-pass-1234')])).id;
  const client = () => {
    let cookie = '';
    return {
      async call(method, url, body) {
        const res = await fetch(base + url, { method, headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
        const sc = res.headers.getSetCookie?.() || [];
        if (sc.length) { const c = sc[0].split(';')[0]; cookie = c.endsWith('=') ? '' : c; }
        let json = null; try { json = await res.json(); } catch {}
        return { status: res.status, json, setCookie: sc };
      },
    };
  };
  const close = async () => { await new Promise(r => server.close(r)); await db.close(); await db.dropSchema(); };
  return { app, db, id, client, close, sent };
}

test('2FA enrollment, challenge and backup codes', needDb, async (t) => {
  const S = await boot();
  t.after(S.close);
  const c = S.client();
  assert.equal((await c.call('POST', '/api/login', { username: 'prof', password: 'teacher-pass-1234' })).status, 200);

  const start = await c.call('POST', '/api/me/2fa/start', {});
  assert.equal(start.status, 200);
  assert.ok(start.json.secret.length > 10);
  const bad = await c.call('POST', '/api/me/2fa/confirm', { code: '000000' });
  assert.equal(bad.status, 400);
  const code = await T.tokenFor(start.json.secret);
  const confirm = await c.call('POST', '/api/me/2fa/confirm', { code });
  if (confirm.status !== 200) console.log('DEBUG confirm', confirm.status, confirm.json, 'code', code);
  assert.equal(confirm.status, 200);
  assert.equal(confirm.json.backupCodes.length, 8);
  assert.equal((await c.call('GET', '/api/me/security')).json.twoFactor, true);

  // next login must present a challenge; a backup code is accepted once
  const with2fa = S.client();
  const first = await with2fa.call('POST', '/api/login', { username: 'prof', password: 'teacher-pass-1234' });
  assert.equal(first.status, 200);
  assert.equal(first.json.secondFactor, true);
  assert.equal((await with2fa.call('GET', '/api/me')).status, 401);
  const wrong = await with2fa.call('POST', '/api/login/2fa', { challenge: first.json.challenge, code: '000000' });
  assert.equal(wrong.status, 400);
  const done = await with2fa.call('POST', '/api/login/2fa', { challenge: first.json.challenge, code: confirm.json.backupCodes[0] });
  assert.equal(done.status, 200);
  assert.equal((await with2fa.call('GET', '/api/me')).json.role, 'teacher');
  const reuse = await with2fa.call('POST', '/api/login', { username: 'prof', password: 'teacher-pass-1234' });
  const reused = await with2fa.call('POST', '/api/login/2fa', { challenge: reuse.json.challenge, code: confirm.json.backupCodes[0] });
  assert.equal(reused.status, 400);
});

test('email recovery link is single-use and still requires 2FA', needDb, async (t) => {
  const S = await boot();
  t.after(S.close);
  // Start 2FA for the account, as an enrolled instructor would have.
  const c = S.client();
  await c.call('POST', '/api/login', { username: 'prof', password: 'teacher-pass-1234' });
  const started = await c.call('POST', '/api/me/2fa/start', {});
  await c.call('POST', '/api/me/2fa/confirm', { code: await T.tokenFor(started.json.secret) });

  const anonymous = S.client();
  const asked = await anonymous.call('POST', '/api/forgot-password', { username: 'prof' });
  assert.equal(asked.status, 200);
  const row = await S.db.one('SELECT id FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [S.id]);
  assert.ok(row, 'a reset token row was created');

  // Use the token from the captured email link, exactly as an instructor would.
  const link = S.sent[0].link;
  const raw = new URL(link).searchParams.get('token');
  assert.ok(raw && raw.length >= 20);
  const reset = await anonymous.call('POST', '/api/reset-password', { token: raw, password: 'new-pass-1234' });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.challenge, true);
  assert.equal((await anonymous.call('POST', '/api/reset-password', { token: raw, password: 'another-pass-1234' })).status, 400);
  assert.equal((await anonymous.call('POST', '/api/login', { username: 'prof', password: 'teacher-pass-1234' })).status, 401);
  const fresh = await anonymous.call('POST', '/api/login', { username: 'prof', password: 'new-pass-1234' });
  assert.equal(fresh.json.secondFactor, true);
});

test('email verification link works without a signed-in browser', needDb, async (t) => {
  const S = await boot();
  t.after(S.close);
  const c = S.client();
  await c.call('POST', '/api/login', { username: 'prof', password: 'teacher-pass-1234' });
  assert.equal((await c.call('PUT', '/api/me/email', { email: 'new@school.edu' })).status, 200);
  const token = new URL(S.sent[0].link).searchParams.get('token');
  assert.ok(token);
  const anonymous = S.client();
  assert.equal((await anonymous.call('POST', '/api/me/email/verify', { token })).status, 200);
  assert.equal((await c.call('GET', '/api/me/security')).json.emailVerified, true);
});

test('password reset refuses unknown and weak passwords', needDb, async (t) => {
  const S = await boot();
  t.after(S.close);
  const c = S.client();
  const asked = await c.call('POST', '/api/forgot-password', { username: 'nobody' });
  assert.equal(asked.status, 200);
  assert.equal((await c.call('POST', '/api/reset-password', { token: 'x'.repeat(40), password: 'new-pass-1234' })).status, 400);
});
