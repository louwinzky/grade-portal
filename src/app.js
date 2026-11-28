'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const { openDb } = require('./db');
const A = require('./auth');
const { mountApi } = require('./api');
const { mountSecurityApi } = require('./security-api');
const { createMailer } = require('./mailer');
const { createSmsGateway } = require('./sms');

async function createApp(opts = {}) {
  const cfg = {
    secureCookie: !!opts.secureCookie,      // set true when served over HTTPS
    trustProxy: opts.trustProxy || false,   // set to 1 when behind a reverse proxy (so req.ip is the real client)
    sessionHours: opts.sessionHours || 8,
  };
  const db = await openDb({ connectionString: opts.connectionString, schema: opts.schema });
  const sessions = A.makeSessions(db, { ttlMs: cfg.sessionHours * 3_600_000, secureCookie: cfg.secureCookie });
  const audit = (userId, action, detail, ip) =>
    db.query('INSERT INTO audit_log (user_id, action, detail, ip) VALUES ($1, $2, $3, $4)', [userId ?? null, action, detail ?? null, ip ?? null]);

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"], baseUri: ["'self'"],
      upgradeInsecureRequests: null,   // would break plain-HTTP LAN use
    } },
    hsts: cfg.secureCookie ? { maxAge: 15552000 } : false,
  }));

  app.get('/healthz', async (req, res) => {   // used by Docker; reveals nothing beyond up/down
    res.set('Cache-Control', 'no-store');
    try { await db.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(sessions.attach);
  app.use('/api', express.json({ limit: '2mb' }));

  // CSRF defence in depth (on top of SameSite=Strict cookies): same-origin + JSON only for state-changing calls
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      let host; try { host = new URL(origin).host; } catch { host = null; }
      if (host !== req.get('host')) return res.status(403).json({ error: 'bad_origin', message: 'Cross-site request blocked.' });
    }
    if (!(req.get('content-type') || '').startsWith('application/json')) return res.status(415).json({ error: 'json_only', message: 'JSON required.' });
    next();
  });

  // Until a temporary password is replaced, the only things a user can do are change it or sign out
  app.use('/api', (req, res, next) => {
    if (req.user && req.user.mustChange && !['/me', '/change-password', '/logout'].includes(req.path))
      return res.status(403).json({ error: 'password_change_required', message: 'Please change your temporary password first.' });
    next();
  });

  const need = role => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated', message: 'Please sign in.' });
    if (role && req.user.role !== role) return res.status(403).json({ error: 'forbidden', message: 'Not allowed.' });
    next();
  };

  // ---------- authentication ----------
  const userLimiter = A.makeLimiter({ max: 5, windowMs: 900_000, lockMs: 900_000 });
  const ipLimiter = A.makeLimiter({ max: 40, windowMs: 900_000, lockMs: 900_000 });

  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || username.length > 64 || password.length > 200)
      return res.status(400).json({ error: 'bad_request', message: 'Enter your username and password.' });
    const uKey = username, iKey = req.ip;   // usernames are case-sensitive
    const wait = Math.max(userLimiter.retryAfterMs(uKey), ipLimiter.retryAfterMs(iKey));
    if (wait) return res.status(429).json({ error: 'locked', message: `Too many attempts. Try again in ${Math.ceil(wait / 60000)} minute(s).` });

    const user = await db.one('SELECT * FROM users WHERE username = $1', [username]);
    const ok = await A.verifyPassword(password, user ? user.password_hash : await A.dummyHash());
    if (!user || !user.active || !ok) {
      userLimiter.fail(uKey); ipLimiter.fail(iKey);
      await audit(user ? user.id : null, 'login_failed', username.slice(0, 64), req.ip);
      return res.status(401).json({ error: 'invalid', message: 'Invalid username or password.' });
    }
    userLimiter.reset(uKey);
    // Instructors with TOTP get a short-lived challenge instead of a session until the code is verified.
    if (user.role === 'teacher' && user.totp_confirmed_at) {
      const challenge = crypto.randomBytes(32).toString('base64url');
      await db.query('DELETE FROM login_challenges WHERE expires_at < now()');
      await db.query('INSERT INTO login_challenges (token_hash, user_id, expires_at, ip) VALUES ($1,$2,now() + make_interval(mins => $3),$4)',
        [A.hashToken(challenge), user.id, 10, req.ip || null]);
      return res.json({ secondFactor: true, challenge, role: 'teacher' });
    }
    await sessions.create(res, user.id, req.ip);
    await audit(user.id, 'login', null, req.ip);
    res.json({ role: user.role, mustChangePassword: user.must_change_password });
  });

  app.post('/api/logout', async (req, res) => {
    if (req.user) await audit(req.user.id, 'logout', null, req.ip);
    await sessions.destroy(req, res);
    res.json({ ok: true });
  });

  app.get('/api/me', need(), (req, res) => {
    const u = req.user;
    res.json({ id: u.id, username: u.username, role: u.role, fullName: u.fullName, mustChangePassword: !!u.mustChange, isOwner: !!u.isOwner });
  });

  app.post('/api/change-password', need(), async (req, res) => {
    const { current, next: pw } = req.body || {};
    if (typeof current !== 'string' || typeof pw !== 'string') return res.status(400).json({ error: 'bad_request', message: 'Fill in both fields.' });
    const row = await db.one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!(await A.verifyPassword(current, row.password_hash))) return res.status(400).json({ error: 'wrong_password', message: 'Current password is incorrect.' });
    const problem = A.checkNewPassword(pw, req.user);
    if (problem) return res.status(400).json({ error: 'weak_password', message: problem });
    if (pw === current) return res.status(400).json({ error: 'same_password', message: 'Choose a different password.' });
    await db.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [await A.hashPassword(pw), req.user.id]);
    await sessions.destroyOthers(req.user.id, req);
    await audit(req.user.id, 'password_changed', null, req.ip);
    res.json({ ok: true });
  });

  // Temporary-password gate must also allow second-factor completion and security setup after a reset.
  const mailer = opts.mailer || createMailer(process.env);
  const smsGateway = opts.smsGateway || createSmsGateway(process.env);
  app.use('/api', (req, res, next) => {
    if (req.user && req.user.mustChange && !['/me', '/change-password', '/logout', '/me/security', '/me/email', '/me/email/verify', '/me/2fa/start', '/me/2fa/confirm', '/me/2fa/disable', '/me/2fa/backup-codes'].includes(req.path))
      return res.status(403).json({ error: 'password_change_required', message: 'Please change your temporary password first.' });
    next();
  });
  // Recovery and challenge routes must be reachable while signed out, so mount them before the generic 404.
  mountSecurityApi(app, { db, need, audit, sessions, mailer, smsGateway });
  mountApi(app, { db, need, audit, sessions });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'Not found.' }));

  // ---------- pages ----------
  const pub = path.join(__dirname, '..', 'public');
  const home = u => (u.role === 'teacher' ? '/admin' : '/student');
  const page = (file, role) => (req, res) => {
    if (role && (!req.user || req.user.role !== role)) return res.redirect('/login');
    // Verification links are normally opened in the same browser the instructor is signed into.
    if (!role && req.user && file !== 'verify-email.html') return res.redirect(home(req.user));
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(pub, file));
  };
  app.get('/', (req, res) => res.redirect(req.user ? home(req.user) : '/login'));
  app.get('/login', page('login.html'));
  app.get('/reset-password', page('reset-password.html'));
  app.get('/verify-email', page('verify-email.html'));
  app.get('/student', page('student.html', 'student'));
  app.get('/admin', page('admin.html', 'teacher'));
  // Cache assets in production; keep local preview refreshes instant (Docker sets NODE_ENV=production).
  const assetCache = process.env.NODE_ENV === 'production' ? { maxAge: '1h' } : { maxAge: 0, etag: false, lastModified: false };
  app.use('/assets', express.static(path.join(pub, 'assets'), assetCache));

  app.use((err, req, res, next) => {  // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'Malformed request.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'File too large.' });
    console.error(err);
    res.status(500).json({ error: 'server_error', message: 'Something went wrong.' });
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
