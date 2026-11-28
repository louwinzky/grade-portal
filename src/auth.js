'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

// scrypt, memory-hard, built into Node (no native bcrypt dependency)
const N = 1 << 15, R = 8, P = 1, KEYLEN = 64;
const maxmem = (n, r) => 128 * n * r * 2;

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(pw, stored) {
  const [alg, n, r, p, saltB, hashB] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB, 'base64');
  const key = await scrypt(pw, Buffer.from(saltB, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: maxmem(+n, +r) });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

let dummy = null; // verified against for unknown usernames so timing doesn't reveal which accounts exist
const dummyHash = async () => (dummy ||= hashPassword(crypto.randomBytes(12).toString('hex')));

// Generic hash for high-entropy, one-time tokens/codes (recovery links, backup codes, challenges).
const hashToken = value => crypto.createHash('sha256').update(String(value)).digest('hex');

// No look-alike characters (0/O, 1/l/I) so temporary passwords survive being read off a printed slip
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function tempPassword(len = 10) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

const COMMON = new Set(['password', 'password1', '12345678', '123456789', 'qwertyuiop', 'iloveyou', 'admin1234']);
function checkNewPassword(pw, user) {
  const min = 8;   // same minimum for instructors and students
  if (typeof pw !== 'string' || pw.length < min) return `Password must be at least ${min} characters.`;
  if (pw.length > 128) return 'Password is too long.';
  if (pw.toLowerCase() === String(user.username).toLowerCase()) return 'Password cannot be your username.';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common.';
  return null;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// Simple in-memory lockout. Fine for a single process; use a shared store if you ever run several.
function makeLimiter({ max, windowMs, lockMs }) {
  const m = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, e] of m) if (now - e.first > windowMs && e.lockedUntil < now) m.delete(k); }, 60_000).unref();
  return {
    retryAfterMs(key) { const e = m.get(key); return e && e.lockedUntil > Date.now() ? e.lockedUntil - Date.now() : 0; },
    fail(key) {
      const now = Date.now();
      let e = m.get(key);
      if (!e || now - e.first > windowMs) { e = { count: 0, first: now, lockedUntil: 0 }; m.set(key, e); }
      if (++e.count >= max) e.lockedUntil = now + lockMs;
    },
    reset(key) { m.delete(key); },
  };
}

function makeSessions(db, { ttlMs, secureCookie }) {
  const hash = t => crypto.createHash('sha256').update(t).digest('hex');
  const cookie = (v, maxAge) => `sid=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const cleanup = () => db.query('DELETE FROM sessions WHERE expires_at < now()').catch(e => console.error('session cleanup failed:', e.message));
  setInterval(cleanup, 3_600_000).unref();
  cleanup();
  return {
    async create(res, userId, ip) {
      const token = crypto.randomBytes(32).toString('base64url');
      await db.query('INSERT INTO sessions (token_hash, user_id, expires_at, ip) VALUES ($1, $2, now() + make_interval(secs => $3), $4)',
        [hash(token), userId, ttlMs / 1000, ip || null]);
      res.setHeader('Set-Cookie', cookie(token, Math.floor(ttlMs / 1000)));
    },
    async destroy(req, res) {
      const t = parseCookies(req.headers.cookie).sid;
      if (t) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hash(t)]);
      res.setHeader('Set-Cookie', cookie('', 0));
    },
    async destroyOthers(userId, req) {
      const t = parseCookies(req.headers.cookie).sid;
      await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, t ? hash(t) : '']);
    },
    destroyAllFor: (userId) => db.query('DELETE FROM sessions WHERE user_id = $1', [userId]),
    // Express middleware: sets req.user (or null)
    async attach(req, res, next) {
      req.user = null;
      const t = parseCookies(req.headers.cookie).sid;
      if (t) {
        req.user = await db.one(`
          SELECT u.id, u.username, u.role, u.full_name AS "fullName", u.student_id AS "studentId",
                 u.is_owner AS "isOwner", u.active, u.must_change_password AS "mustChange",
                 u.totp_confirmed_at IS NOT NULL AS "twoFactor", u.email
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [hash(t)]) || null;
      }
      next();
    },
  };
}

module.exports = { hashPassword, verifyPassword, dummyHash, hashToken, tempPassword, checkNewPassword, makeLimiter, makeSessions };
