'use strict';
const A = require('./auth');
const { PERIODS, isUniqueViolation } = require('./db');
const { parseRegistrarCsv } = require('./csv');

class Rollback extends Error {}
const text = (v, min, max) => (typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);
const toId = v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 2_147_483_647 ? n : null; };

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
      SELECT s.*, (SELECT COUNT(*) FROM enrollments WHERE subject_id = s.id)::int AS enrolled
      FROM subjects s WHERE owner_id = $1 ORDER BY s.term DESC, s.title`, [req.user.id]);
    res.json(rows.map(s => ({ id: s.id, code: s.code, title: s.title, term: s.term, section: s.section, enrolled: s.enrolled, released: relObj(s) })));
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
    res.json({ id: s.id, code: s.code, title: s.title, term: s.term, section: s.section, released: relObj(s), students });
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
          let st = await q.one('SELECT id, full_name FROM students WHERE lower(student_no) = lower($1)', [r.studentNo]);
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

  app.get('/api/admin/audit', need('teacher'), async (req, res) => {
    res.json(await db.all(`SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS at, action, detail, ip
                           FROM audit_log WHERE user_id = $1 ORDER BY id DESC LIMIT 100`, [req.user.id]));
  });
}

module.exports = { mountApi };
