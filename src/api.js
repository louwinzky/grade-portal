'use strict';
const A = require('./auth');
const { PERIODS, isUniqueViolation } = require('./db');
const { parseRegistrarCsv, parseCSV } = require('./csv');

class Rollback extends Error {}
const text = (v, min, max) => (typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);
const toId = v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 2_147_483_647 ? n : null; };

// CSV for onboarding instructors: "Username, Full name" with an optional Owner column.
// Rows are validated in full before anything is written; bad rows are reported, not applied.
function parseTeacherCsv(csv) {
  const rows = parseCSV(csv);
  const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  const hi = rows.findIndex(r => r.some(c => norm(c) === 'username') && r.some(c => norm(c) === 'full name'));
  if (hi < 0) throw new Error('Could not find a header row with "Username" and "Full name".');
  const header = rows[hi].map(norm);
  const iUser = header.indexOf('username'), iName = header.indexOf('full name'), iOwner = header.indexOf('owner');
  const out = [], errors = [], seen = new Set();
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every(c => !String(c).trim())) continue;
    const line = i + 1;
    try {
      const username = String(r[iUser] || '').trim();
      const fullName = String(r[iName] || '').trim();
      if (!/^[A-Za-z0-9._-]{2,64}$/.test(username)) throw new Error('Username must be 2-64 letters, digits, dot, underscore or hyphen');
      if (!fullName || fullName.length > 80) throw new Error('Full name is required (max 80 characters)');
      if (seen.has(username)) throw new Error('duplicate username in file');
      seen.add(username);
      const owner = iOwner >= 0 && /^(true|yes|1|owner)$/i.test(String(r[iOwner] || '').trim());
      out.push({ line, username, fullName, owner });
    } catch (e) { errors.push({ line, reason: e.message }); }
  }
  return { rows: out, errors };
}

function mountApi(app, { db, need, audit, sessions }) {
  // ================= STUDENT: read-only, own grades, released periods only =================
  app.get('/api/student/grades', need('student'), async (req, res) => {
    const rows = await db.all(`
      SELECT s.code, s.title, s.term, s.section, t.full_name AS instructor,
             s.rel_prelim, s.rel_midterm, s.rel_prefinal, s.rel_finals,
             e.prelim, e.midterm, e.prefinal, e.finals, e.final_gp, e.remark, e.updated_at
      FROM enrollments e
      JOIN subjects s ON s.id = e.subject_id
      JOIN users t ON t.id = s.owner_id
      WHERE e.student_id = $1
      ORDER BY s.term DESC, s.title`, [req.user.studentId]);
    const subjects = rows.map(r => {
      // Unreleased values are nulled on the server; they never reach the browser.
      const periods = PERIODS.map(p => ({ key: p.key, label: p.label, released: r[p.rel], value: r[p.rel] ? r[p.col] : null }));
      const complete = periods.every(p => p.released);   // the final grade only appears once every period is out
      return {
        code: r.code, title: r.title, term: r.term, section: r.section, instructor: r.instructor,
        periods, finalVisible: complete, finalGrade: complete ? r.final_gp : null, remark: complete ? r.remark : null,
        updatedAt: r.updated_at,
      };
    });
    res.json({ student: { fullName: req.user.fullName }, subjects });
  });

  // ================= TEACHER =================
  const mine = async (req) => {
    const id = toId(req.params.id);
    return id ? db.one('SELECT * FROM subjects WHERE id = $1 AND owner_id = $2', [id, req.user.id]) : undefined;
  };
  const relObj = s => Object.fromEntries(PERIODS.map(p => [p.key, s[p.rel]]));
  const notFound = res => res.status(404).json({ error: 'not_found', message: 'Subject not found.' });

  app.get('/api/admin/subjects', need('teacher'), async (req, res) => {
    const rows = await db.all(`
      SELECT s.*,
             (SELECT COUNT(*) FROM enrollments e WHERE e.subject_id = s.id)::int AS enrolled,
             (SELECT COUNT(*) FROM enrollments e WHERE e.subject_id = s.id
                AND NOT EXISTS (SELECT 1 FROM users u WHERE u.student_id = e.student_id))::int AS "accountsPending"
      FROM subjects s WHERE owner_id = $1 ORDER BY s.term DESC, s.title`, [req.user.id]);
    res.json(rows.map(s => ({
      id: s.id, code: s.code, title: s.title, term: s.term, section: s.section,
      enrolled: s.enrolled, accountsPending: s.accountsPending,
      lastImportAt: s.last_import_at || null, released: relObj(s),
    })));
  });

  app.post('/api/admin/subjects', need('teacher'), async (req, res) => {
    const b = req.body || {};
    const code = text(b.code, 2, 20), title = text(b.title, 2, 80), term = text(b.term, 2, 40);
    const section = b.section == null || b.section === '' ? '' : text(b.section, 1, 20);
    if (!code || !title || !term || section === null) return res.status(400).json({ error: 'bad_request', message: 'Code, title and term are required.' });
    try {
      const row = await db.one('INSERT INTO subjects (owner_id, code, title, term, section) VALUES ($1,$2,$3,$4,$5) RETURNING id', [req.user.id, code, title, term, section]);
      await audit(req.user.id, 'subject_created', `${code} ${term} ${section}`.trim(), req.ip);
      res.status(201).json({ id: row.id });
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(409).json({ error: 'exists', message: 'That subject/term/section already exists.' });
      throw e;
    }
  });

  // Delete a subject and its published grades. Student accounts and other subjects are untouched.
  app.delete('/api/admin/subjects/:id', need('teacher'), async (req, res) => {
    const s = await mine(req);
    if (!s) return notFound(res);
    await db.query('DELETE FROM subjects WHERE id = $1 AND owner_id = $2', [s.id, req.user.id]);
    await audit(req.user.id, 'subject_deleted', `${s.code} ${s.term} ${s.section}`.trim(), req.ip);
    res.json({ ok: true });
  });

  // Edit a subject's details (code, title, term, section). Grades stay import-only on purpose.
  app.put('/api/admin/subjects/:id', need('teacher'), async (req, res) => {
    const s = await mine(req);
    if (!s) return notFound(res);
    const b = req.body || {};
    const code = text(b.code, 2, 20), title = text(b.title, 2, 80), term = text(b.term, 2, 40);
    const section = b.section == null || b.section === '' ? '' : text(b.section, 1, 20);
    if (!code || !title || !term || section === null) return res.status(400).json({ error: 'bad_request', message: 'Code, title and term are required.' });
    try {
      const row = await db.one('UPDATE subjects SET code = $1, title = $2, term = $3, section = $4 WHERE id = $5 AND owner_id = $6 RETURNING *',
        [code, title, term, section, s.id, req.user.id]);
      await audit(req.user.id, 'subject_updated', `${row.code} ${row.term} ${row.section}`.trim(), req.ip);
      res.json({ id: row.id, code: row.code, title: row.title, term: row.term, section: row.section });
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(409).json({ error: 'exists', message: 'Another subject already uses that code, term and section.' });
      throw e;
    }
  });

  app.get('/api/admin/subjects/:id', need('teacher'), async (req, res) => {
    const s = await mine(req);
    if (!s) return notFound(res);
    const students = await db.all(`
      SELECT st.id AS "studentId", st.student_no AS "studentNo", st.full_name AS "fullName",
             e.prelim, e.midterm, e.prefinal, e.finals, e.final_pct AS "finalPct", e.final_gp AS "finalGp", e.remark,
             (u.id IS NOT NULL) AS "hasAccount"
      FROM enrollments e JOIN students st ON st.id = e.student_id LEFT JOIN users u ON u.student_id = st.id
      WHERE e.subject_id = $1 ORDER BY st.full_name`, [s.id]);
    res.json({ id: s.id, code: s.code, title: s.title, term: s.term, section: s.section,
      lastImportAt: s.last_import_at || null, released: relObj(s), students });
  });

  app.put('/api/admin/subjects/:id/releases', need('teacher'), async (req, res) => {
    const s = await mine(req);
    if (!s) return notFound(res);
    const b = req.body || {};
    const sets = [], vals = [], changed = [];
    for (const p of PERIODS) {
      if (typeof b[p.key] === 'boolean') { vals.push(b[p.key]); sets.push(`${p.rel} = $${vals.length}`); changed.push(`${p.key}=${b[p.key] ? 'released' : 'hidden'}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'bad_request', message: 'Nothing to update.' });
    vals.push(s.id);
    const row = await db.one(`UPDATE subjects SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);   // column names come from PERIODS, never from the client
    await audit(req.user.id, 'releases_changed', `${s.code} ${s.term}: ${changed.join(', ')}`, req.ip);
    res.json({ released: relObj(row) });
  });

  // Import the gradebook's Registrar Report CSV. dryRun=true validates and reports without saving.
  app.post('/api/admin/subjects/:id/import', need('teacher'), async (req, res) => {
    const s = await mine(req);
    if (!s) return notFound(res);
    const { csv, dryRun } = req.body || {};
    if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'bad_request', message: 'No file content received.' });
    let parsed;
    try { parsed = parseRegistrarCsv(csv); } catch (e) { return res.status(400).json({ error: 'bad_csv', message: e.message }); }

    const stats = { rows: parsed.rows.length, newStudents: 0, renamed: 0, newEnrollments: 0, updatedEnrollments: 0 };
    try {
      await db.tx(async (q) => {
        for (const r of parsed.rows) {
          let st = await q.one('SELECT id, full_name FROM students WHERE student_no = $1', [r.studentNo]);
          if (!st) { st = await q.one('INSERT INTO students (student_no, full_name) VALUES ($1,$2) RETURNING id', [r.studentNo, r.fullName]); stats.newStudents++; }
          else if (st.full_name !== r.fullName) { await q.query('UPDATE students SET full_name = $1 WHERE id = $2', [r.fullName, st.id]); stats.renamed++; }
          // atomic upsert; (xmax = 0) is true only for rows that were newly inserted
          const up = await q.one(`
            INSERT INTO enrollments (subject_id, student_id, prelim, midterm, prefinal, finals, final_pct, final_gp, remark)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT (subject_id, student_id) DO UPDATE SET
              prelim = EXCLUDED.prelim, midterm = EXCLUDED.midterm, prefinal = EXCLUDED.prefinal, finals = EXCLUDED.finals,
              final_pct = EXCLUDED.final_pct, final_gp = EXCLUDED.final_gp, remark = EXCLUDED.remark, updated_at = now()
            RETURNING (xmax = 0) AS inserted`,
            [s.id, st.id, r.prelim, r.midterm, r.prefinal, r.finals, r.finalPct, r.gp, r.remark]);
          if (up.inserted) stats.newEnrollments++; else stats.updatedEnrollments++;
        }
        if (dryRun) throw new Rollback();
        await q.query('UPDATE subjects SET last_import_at = now() WHERE id = $1', [s.id]);
      });
    } catch (e) { if (!(e instanceof Rollback)) throw e; }
    if (!dryRun) await audit(req.user.id, 'grades_imported', `${s.code} ${s.term}: ${stats.rows} rows, ${parsed.errors.length} skipped`, req.ip);
    res.json({ dryRun: !!dryRun, ...stats, skipped: parsed.errors });
  });

  const credentials = async () => { const pw = A.tempPassword(); return { pw, hash: await A.hashPassword(pw) }; };

  // Create sign-in accounts for enrolled students who don't have one. Passwords are returned ONCE.
  app.post('/api/admin/subjects/:id/accounts', need('teacher'), async (req, res) => {
    const s = await mine(req);
    if (!s) return notFound(res);
    const pending = await db.all(`
      SELECT st.id, st.student_no, st.full_name FROM enrollments e JOIN students st ON st.id = e.student_id
      WHERE e.subject_id = $1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.student_id = st.id) ORDER BY st.full_name`, [s.id]);
    const made = [];
    for (const st of pending) {
      const c = await credentials();
      try {
        await db.query("INSERT INTO users (username, password_hash, role, full_name, student_id, must_change_password) VALUES ($1,$2,'student',$3,$4,true)", [st.student_no, c.hash, st.full_name, st.id]);
        made.push({ studentNo: st.student_no, fullName: st.full_name, username: st.student_no, tempPassword: c.pw });
      } catch (e) { if (!isUniqueViolation(e)) throw e; }
    }
    await audit(req.user.id, 'accounts_created', `${s.code} ${s.term}: ${made.length} account(s)`, req.ip);
    res.json({ created: made });
  });

  app.post('/api/admin/students/:studentId/reset-password', need('teacher'), async (req, res) => {
    const sid = toId(req.params.studentId);
    const row = sid && await db.one(`
      SELECT u.id AS "userId", st.student_no, st.full_name FROM students st
      JOIN users u ON u.student_id = st.id
      WHERE st.id = $1 AND EXISTS (SELECT 1 FROM enrollments e JOIN subjects s ON s.id = e.subject_id WHERE e.student_id = st.id AND s.owner_id = $2)`, [sid, req.user.id]);
    if (!row) return res.status(404).json({ error: 'not_found', message: 'Student not found.' });
    const c = await credentials();
    await db.query('UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2', [c.hash, row.userId]);
    await sessions.destroyAllFor(row.userId);
    await audit(req.user.id, 'password_reset', row.student_no, req.ip);
    res.json({ studentNo: row.student_no, fullName: row.full_name, username: row.student_no, tempPassword: c.pw });
  });

  // ================= INSTRUCTOR ACCOUNT MANAGEMENT (owner only) =================
  const teacherOnly = need('teacher');
  const needOwner = (req, res, next) => teacherOnly(req, res, () => {
    if (!req.user.isOwner) return res.status(403).json({ error: 'forbidden', message: 'Owner access required.' });
    next();
  });
  const teacherById = (req) => {
    const id = toId(req.params.id);
    return id ? db.one("SELECT * FROM users WHERE id = $1 AND role = 'teacher'", [id]) : undefined;
  };
  const activeOwners = async () => (await db.one("SELECT COUNT(*)::int AS c FROM users WHERE role = 'teacher' AND is_owner AND active")).c;

  app.get('/api/admin/teachers', needOwner, async (req, res) => {
    res.json(await db.all(`
      SELECT u.id, u.username, u.full_name AS "fullName", u.is_owner AS "isOwner", u.active,
             to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "createdAt",
             (SELECT COUNT(*) FROM subjects s WHERE s.owner_id = u.id)::int AS "subjectCount",
             (SELECT to_char(max(a.at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI')
                FROM audit_log a WHERE a.user_id = u.id AND a.action = 'login') AS "lastLogin"
      FROM users u WHERE u.role = 'teacher'
      ORDER BY u.is_owner DESC, u.active DESC, u.full_name`));
  });

  app.post('/api/admin/teachers', needOwner, async (req, res) => {
    const b = req.body || {};
    const username = text(b.username, 2, 64), fullName = text(b.fullName, 2, 80);
    if (!username || !fullName) return res.status(400).json({ error: 'bad_request', message: 'Username and full name are required.' });
    const pw = A.tempPassword(16);
    try {
      const row = await db.one(
        "INSERT INTO users (username, password_hash, role, full_name, is_owner, must_change_password) VALUES ($1,$2,'teacher',$3,$4,true) RETURNING id",
        [username, await A.hashPassword(pw), fullName, b.owner === true]);
      await audit(req.user.id, 'teacher_created', `${username} (${fullName})${b.owner === true ? ' [owner]' : ''}`, req.ip);
      res.status(201).json({ id: row.id, username, fullName, isOwner: b.owner === true, tempPassword: pw });
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(409).json({ error: 'exists', message: 'That username is already in use.' });
      throw e;
    }
  });

  // Bulk onboarding from a CSV of usernames and names. One temporary password per row, shown once.
  app.post('/api/admin/teachers/bulk', needOwner, async (req, res) => {
    const csv = (req.body || {}).csv;
    if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'bad_request', message: 'No CSV content received.' });
    let parsed;
    try { parsed = parseTeacherCsv(csv); } catch (e) { return res.status(400).json({ error: 'bad_csv', message: e.message }); }

    const MAX_TEACHERS = 50;
    const current = await db.all("SELECT username FROM users WHERE role = 'teacher'");
    if (current.length + parsed.rows.length > MAX_TEACHERS)
      return res.status(400).json({ error: 'too_many', message: `This portal supports up to ${MAX_TEACHERS} instructor accounts. The file would create too many.` });

    const existing = new Set(current.map(t => t.username));
    const created = [], errors = [...parsed.errors];
    for (const row of parsed.rows) {
      if (existing.has(row.username)) { errors.push({ line: row.line, reason: 'username already exists' }); continue; }
      const pw = A.tempPassword(16);
      try {
        await db.query(
          "INSERT INTO users (username, password_hash, role, full_name, is_owner, must_change_password) VALUES ($1,$2,'teacher',$3,$4,true)",
          [row.username, await A.hashPassword(pw), row.fullName, row.owner]);
        existing.add(row.username);
        created.push({ username: row.username, fullName: row.fullName, isOwner: row.owner, tempPassword: pw });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        errors.push({ line: row.line, reason: 'username already exists' });
      }
    }
    if (created.length) await audit(req.user.id, 'teachers_bulk_created', `${created.length} account(s)`, req.ip);
    res.json({ created, errors, totalTeachers: current.length + created.length });
  });

  app.post('/api/admin/teachers/:id/reset-password', needOwner, async (req, res) => {
    const t = await teacherById(req);
    if (!t) return notFound(res);
    // Resetting yourself signs you out before you can copy the one-time password.
    if (t.id === req.user.id)
      return res.status(400).json({ error: 'self_reset',
        message: 'Use Account → Change password for your own password. If you are locked out, an operator can reset it with scripts/reset-teacher-password.js.' });
    const pw = A.tempPassword(16);
    await db.tx(async q => {
      await q.query('UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2', [await A.hashPassword(pw), t.id]);
      await q.query('DELETE FROM sessions WHERE user_id = $1', [t.id]);
    });
    await audit(req.user.id, 'teacher_password_reset', t.username, req.ip);
    res.json({ id: t.id, username: t.username, fullName: t.full_name, tempPassword: pw });
  });

  app.put('/api/admin/teachers/:id/active', needOwner, async (req, res) => {
    const t = await teacherById(req);
    if (!t) return notFound(res);
    if (t.id === req.user.id) return res.status(400).json({ error: 'bad_request', message: 'You cannot disable your own account.' });
    const active = (req.body || {}).active;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'bad_request', message: 'Pass active as true or false.' });
    if (!active && t.is_owner && t.active && await activeOwners() <= 1)
      return res.status(400).json({ error: 'last_owner', message: 'At least one active owner must remain.' });
    await db.query('UPDATE users SET active = $1 WHERE id = $2', [active, t.id]);
    if (!active) await sessions.destroyAllFor(t.id);
    await audit(req.user.id, active ? 'teacher_reactivated' : 'teacher_deactivated', t.username, req.ip);
    res.json({ id: t.id, active });
  });

  app.put('/api/admin/teachers/:id/owner', needOwner, async (req, res) => {
    const t = await teacherById(req);
    if (!t) return notFound(res);
    const owner = (req.body || {}).owner;
    if (typeof owner !== 'boolean') return res.status(400).json({ error: 'bad_request', message: 'Pass owner as true or false.' });
    if (t.id === req.user.id && !owner) return res.status(400).json({ error: 'bad_request', message: 'You cannot remove your own owner access.' });
    if (!owner && t.is_owner && t.active && await activeOwners() <= 1)
      return res.status(400).json({ error: 'last_owner', message: 'At least one active owner must remain.' });
    await db.query('UPDATE users SET is_owner = $1 WHERE id = $2', [owner, t.id]);
    await audit(req.user.id, owner ? 'owner_granted' : 'owner_revoked', t.username, req.ip);
    res.json({ id: t.id, isOwner: owner });
  });

  app.get('/api/admin/audit', need('teacher'), async (req, res) => {
    res.json(await db.all(`SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS at, action, detail, ip
                           FROM audit_log WHERE user_id = $1 ORDER BY id DESC LIMIT 100`, [req.user.id]));
  });
}

module.exports = { mountApi };
