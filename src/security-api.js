'use strict';
// Instructor self-service security: 2FA enrollment/management and email password recovery.
const crypto = require('crypto');
const A = require('./auth');
const T = require('./totp');
const { randomCode } = require('./security');

const CHALLENGE_MINUTES = 10;
const RESET_MINUTES = 30;
const CODE_COUNT = 8;
const text = (v, min, max) => (typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);
const cleanToken = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(v) ? v : null);

function mountSecurityApi(app, { db, need, audit, sessions, mailer, smsGateway }) {
  const twoFactorLimiter = A.makeLimiter({ max: 8, windowMs: 900_000, lockMs: 900_000 });
  const recoveryLimiter = A.makeLimiter({ max: 5, windowMs: 900_000, lockMs: 900_000 });
  const resetLimiter = A.makeLimiter({ max: 10, windowMs: 900_000, lockMs: 900_000 });

  const generateCodes = async (q, userId) => {
    await q.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    const codes = Array.from({ length: CODE_COUNT }, () => randomCode(12));
    for (const code of codes)
      await q.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1,$2)', [userId, A.hashToken(code)]);
    return codes;
  };

  // Public: request an email reset link. Always answers the same way, whether or not the account exists.
  app.post('/api/forgot-password', async (req, res) => {
    const username = text((req.body || {}).username, 2, 64);
    const ipKey = `ip:${req.ip}`;
    if (!username) return res.status(400).json({ error: 'bad_request', message: 'Enter your instructor username.' });
    const wait = Math.max(recoveryLimiter.retryAfterMs(username), recoveryLimiter.retryAfterMs(ipKey));
    if (wait) return res.status(429).json({ error: 'locked', message: `Too many requests. Try again in ${Math.ceil(wait / 60000)} minute(s).` });
    recoveryLimiter.fail(username); recoveryLimiter.fail(ipKey);

    const user = await db.one("SELECT id, username, full_name, email, email_verified_at FROM users WHERE username = $1 AND role = 'teacher' AND active", [username]);
    if (!user || !user.email || !user.email_verified_at || !mailer.configured) {
      return res.json({ ok: true, message: 'If an instructor account with that username has a verified email, a reset link has been sent.' });
    }
    const raw = crypto.randomBytes(32).toString('base64url');
    await db.query('DELETE FROM password_resets WHERE expires_at < now()');
    await db.query('INSERT INTO password_resets (user_id, token_hash, requested_ip, expires_at) VALUES ($1,$2,$3,now() + make_interval(mins => $4))',
      [user.id, A.hashToken(raw), req.ip || null, RESET_MINUTES]);
    const link = `${mailer.baseUrl}/reset-password?token=${raw}`;
    await mailer.sendPasswordReset({ to: user.email, fullName: user.full_name, link });
    await audit(user.id, 'password_reset_requested', null, req.ip);
    res.json({ ok: true, message: 'If an instructor account with that username has a verified email, a reset link has been sent.' });
  });

  // Public: consume a reset token and choose a new password. If 2FA is on, issue a challenge instead
  // of signing in immediately so the second factor is still enforced after a recovery reset.
  app.post('/api/reset-password', async (req, res) => {
    const b = req.body || {};
    const token = cleanToken(b.token), pw = b.password;
    if (!token || typeof pw !== 'string') return res.status(400).json({ error: 'bad_request', message: 'Invalid reset link.' });
    const wait = resetLimiter.retryAfterMs(req.ip);
    if (wait) return res.status(429).json({ error: 'locked', message: `Too many attempts. Try again in ${Math.ceil(wait / 60000)} minute(s).` });

    const reset = await db.one('SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()', [A.hashToken(token)]);
    if (!reset) { resetLimiter.fail(req.ip); return res.status(400).json({ error: 'invalid_token', message: 'This reset link is invalid or has expired.' }); }
    const user = await db.one("SELECT * FROM users WHERE id = $1 AND role = 'teacher' AND active", [reset.user_id]);
    if (!user) { resetLimiter.fail(req.ip); return res.status(400).json({ error: 'invalid_token', message: 'This reset link is invalid or has expired.' }); }
    const problem = A.checkNewPassword(pw, user);
    if (problem) return res.status(400).json({ error: 'weak_password', message: problem });

    let challengeToken = null;
    await db.tx(async q => {
      await q.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [reset.id]);
      await q.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [await A.hashPassword(pw), user.id]);
      await q.query('DELETE FROM password_resets WHERE user_id = $1', [user.id]);   // one live link per instructor
      await q.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
      if (user.totp_confirmed_at) {
        challengeToken = crypto.randomBytes(32).toString('base64url');
        await q.query('INSERT INTO login_challenges (token_hash, user_id, expires_at, ip) VALUES ($1,$2,now() + make_interval(mins => $3),$4)',
          [A.hashToken(challengeToken), user.id, CHALLENGE_MINUTES, req.ip || null]);
      }
    });
    resetLimiter.reset(req.ip);
    await audit(user.id, 'password_reset_completed', null, req.ip);
    res.json({ ok: true, challenge: !!challengeToken, challengeToken });
  });

  // Public: finish a password login for a 2FA-enabled instructor (issued by /api/login).
  app.post('/api/login/2fa', async (req, res) => {
    const b = req.body || {};
    const token = cleanToken(b.challenge), code = text(b.code, 6, 12);
    if (!token || !code) return res.status(400).json({ error: 'bad_request', message: 'Enter your authenticator or backup code.' });
    const wait = twoFactorLimiter.retryAfterMs(token);
    if (wait) return res.status(429).json({ error: 'locked', message: `Too many attempts. Try again in ${Math.ceil(wait / 60000)} minute(s).` });

    const ch = await db.one('SELECT * FROM login_challenges WHERE token_hash = $1 AND expires_at > now()', [A.hashToken(token)]);
    if (!ch || ch.attempts >= 5) {
      twoFactorLimiter.fail(token);
      return res.status(400).json({ error: 'invalid_code', message: 'That code is invalid or the challenge expired. Sign in again.' });
    }
    const user = await db.one("SELECT * FROM users WHERE id = $1 AND role = 'teacher' AND active AND totp_confirmed_at IS NOT NULL", [ch.user_id]);
    if (!user) return res.status(400).json({ error: 'invalid_code', message: 'Sign in again.' });

    const codeNorm = code.toUpperCase();
    let accepted = await T.verifyToken(user.totp_secret, code);
    if (!accepted && /^[A-Z2-9]{10,12}$/.test(codeNorm)) {
      const row = await db.one('SELECT id FROM recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL', [user.id, A.hashToken(codeNorm)]);
      if (row) { await db.query('UPDATE recovery_codes SET used_at = now() WHERE id = $1', [row.id]); accepted = true; }
    }
    if (!accepted) {
      await db.query('UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = $1', [A.hashToken(token)]);
      twoFactorLimiter.fail(token);
      await audit(user.id, 'two_factor_failed', null, req.ip);
      return res.status(400).json({ error: 'invalid_code', message: 'That code is incorrect.' });
    }
    await db.query('DELETE FROM login_challenges WHERE token_hash = $1', [A.hashToken(token)]);
    twoFactorLimiter.reset(token);
    await sessions.create(res, user.id, req.ip);
    await audit(user.id, 'login_2fa', null, req.ip);
    res.json({ role: 'teacher', mustChangePassword: !!user.must_change_password });
  });

  const teacher = need('teacher');

  // Signed-in instructor: 2FA status and self-service enrollment/disable.
  app.get('/api/me/security', teacher, async (req, res) => {
    const u = await db.one(`SELECT email, email_verified_at IS NOT NULL AS "emailVerified",
                                   totp_confirmed_at IS NOT NULL AS "twoFactor",
                                   (SELECT COUNT(*)::int FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL) AS "backupCodesLeft"
                            FROM users WHERE id = $1`, [req.user.id]);
    const codes = u.emailVerified && smsGateway.enabled;
    res.json({ ...u, smsReady: codes, smsEnabled: false, recoveryChannel: u.emailVerified ? 'email' : null });
  });

  app.put('/api/me/email', teacher, async (req, res) => {
    const email = text((req.body || {}).email, 5, 200);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'bad_request', message: 'Enter a valid email address.' });
    await db.query('UPDATE users SET email = $1, email_verified_at = NULL WHERE id = $2', [email, req.user.id]);
    if (mailer.configured) {
      const raw = crypto.randomBytes(24).toString('base64url');
      // Verification is a one-time link to a dedicated page; it cannot change privileges.
      await db.query('INSERT INTO password_resets (user_id, token_hash, requested_ip, expires_at) VALUES ($1,$2,$3,now() + make_interval(mins => $4))',
        [req.user.id, A.hashToken('verify:' + raw), req.ip || null, RESET_MINUTES]);
      await mailer.sendPasswordReset({ to: email, fullName: req.user.fullName, link: `${mailer.baseUrl}/verify-email?token=${raw}` });
    }
    await audit(req.user.id, 'email_changed', null, req.ip);
    res.json({ ok: true, email, verified: false, emailSent: mailer.configured });
  });

  // Public: verification links may be opened from any device, not just the signed-in browser.
  app.post('/api/me/email/verify', async (req, res) => {
    const token = cleanToken((req.body || {}).token);
    if (!token) return res.status(400).json({ error: 'bad_request', message: 'Invalid verification link.' });
    const row = await db.one('SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()', [A.hashToken('verify:' + token)]);
    if (!row) return res.status(400).json({ error: 'invalid_token', message: 'The verification link is invalid or has expired.' });
    await db.tx(async q => {
      await q.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [row.id]);
      await q.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [row.user_id]);
    });
    await audit(row.user_id, 'email_verified', null, req.ip);
    res.json({ ok: true, verified: true });
  });

  app.post('/api/me/2fa/start', teacher, async (req, res) => {
    const u = await db.one('SELECT username, totp_confirmed_at FROM users WHERE id = $1', [req.user.id]);
    if (u.totp_confirmed_at) return res.status(409).json({ error: 'already_enabled', message: 'Two-factor sign-in is already enabled.' });
    const secret = await T.newSecret();
    await db.query('UPDATE users SET pending_totp_secret = $1, pending_totp_at = now() WHERE id = $2', [secret, req.user.id]);
    res.json({ secret, uri: T.provisioningUri(secret, u.username), issuer: T.ISSUER });
  });

  app.post('/api/me/2fa/confirm', teacher, async (req, res) => {
    const u = await db.one('SELECT pending_totp_secret, totp_confirmed_at FROM users WHERE id = $1', [req.user.id]);
    if (u.totp_confirmed_at || !u.pending_totp_secret) return res.status(400).json({ error: 'bad_request', message: 'Start enrollment first.' });
    const code = text((req.body || {}).code, 6, 6);
    if (!code || !(await T.verifyToken(u.pending_totp_secret, code)))
      return res.status(400).json({ error: 'invalid_code', message: 'That code is incorrect. Check the time on your phone.' });
    let codes;
    await db.tx(async q => {
      await q.query('UPDATE users SET totp_secret = pending_totp_secret, totp_confirmed_at = now(), pending_totp_secret = NULL, pending_totp_at = NULL WHERE id = $1', [req.user.id]);
      codes = await generateCodes(q, req.user.id);
    });
    await sessions.destroyOthers(req.user.id, req);
    await audit(req.user.id, 'two_factor_enabled', null, req.ip);
    res.json({ ok: true, backupCodes: codes });
  });

  app.post('/api/me/2fa/disable', teacher, async (req, res) => {
    const pw = (req.body || {}).password;
    if (typeof pw !== 'string') return res.status(400).json({ error: 'bad_request', message: 'Enter your password.' });
    const u = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await A.verifyPassword(pw, u.password_hash)))
      return res.status(400).json({ error: 'wrong_password', message: 'Password is incorrect.' });
    await db.tx(async q => {
      await q.query('UPDATE users SET totp_secret = NULL, totp_confirmed_at = NULL, pending_totp_secret = NULL, pending_totp_at = NULL WHERE id = $1', [req.user.id]);
      await q.query('DELETE FROM recovery_codes WHERE user_id = $1', [req.user.id]);
      await q.query('DELETE FROM login_challenges WHERE user_id = $1', [req.user.id]);
    });
    await audit(req.user.id, 'two_factor_disabled', null, req.ip);
    res.json({ ok: true });
  });

  app.post('/api/me/2fa/backup-codes', teacher, async (req, res) => {
    const pw = (req.body || {}).password;
    if (typeof pw !== 'string') return res.status(400).json({ error: 'bad_request', message: 'Enter your password.' });
    const u = await db.one('SELECT password_hash, totp_confirmed_at FROM users WHERE id = $1', [req.user.id]);
    if (!u.totp_confirmed_at) return res.status(400).json({ error: 'bad_request', message: 'Enable two-factor sign-in first.' });
    if (!(await A.verifyPassword(pw, u.password_hash)))
      return res.status(400).json({ error: 'wrong_password', message: 'Password is incorrect.' });
    let codes;
    await db.tx(async q => { codes = await generateCodes(q, req.user.id); });
    await audit(req.user.id, 'backup_codes_regenerated', null, req.ip);
    res.json({ ok: true, backupCodes: codes });
  });
}

module.exports = { mountSecurityApi };
