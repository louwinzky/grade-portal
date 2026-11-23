'use strict';
// Minimal RFC-4180 style CSV parser (quoted fields, escaped quotes, CRLF, BOM).
function parseCSV(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Reads the gradebook's "Registrar Report" CSV: finds the header row (title lines above it are ignored),
// maps columns by name, and validates every row.
function parseRegistrarCsv(text) {
  const rows = parseCSV(text);
  const norm = s => String(s).trim().toLowerCase();
  const hi = rows.findIndex(r => r.some(c => norm(c) === 'student name') && r.some(c => norm(c) === 'student id'));
  if (hi < 0) throw new Error('Could not find a header row containing "Student Name" and "Student ID". Use the gradebook\'s Registrar Report (CSV).');
  const header = rows[hi].map(norm);
  const col = (...names) => header.findIndex(h => names.includes(h));
  const idx = {
    name: col('student name'), id: col('student id'),
    prelim: col('prelim (%)', 'prelim'), midterm: col('midterm (%)', 'midterm'),
    prefinal: col('pre-final (%)', 'pre-final', 'prefinal'), finals: col('final (%)', 'finals'),
    finalPct: col('final grade'), gp: col('grade point'), remark: col('remark'),
  };
  const missing = Object.entries(idx).filter(([k, v]) => v < 0 && k !== 'finalPct').map(([k]) => k);
  if (missing.length) throw new Error('Missing column(s): ' + missing.join(', '));

  const pct = (s, label) => {
    const n = Number(String(s).trim());
    if (String(s).trim() === '' || !Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${label} must be 0-100`);
    return Math.round(n * 100) / 100;
  };
  const out = [], errors = [], seen = new Set();
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every(c => String(c).trim() === '')) continue;
    const line = i + 1;
    try {
      const studentNo = String(r[idx.id] || '').trim();
      const fullName = String(r[idx.name] || '').trim();
      if (!studentNo) throw new Error('no Student ID (fill it in the gradebook)');
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(studentNo)) throw new Error('Student ID has unsupported characters');
      if (!fullName || fullName.length > 120) throw new Error('missing or too-long name');
      if (seen.has(studentNo.toLowerCase())) throw new Error('duplicate Student ID in file');
      seen.add(studentNo.toLowerCase());
      const gp = Number(String(r[idx.gp]).trim());
      if (!Number.isFinite(gp) || gp < 1 || gp > 5) throw new Error('Grade Point must be 1.00-5.00');
      const remark = String(r[idx.remark] || '').trim();
      if (!['Passed', 'Failed', 'Dropped'].includes(remark)) throw new Error('Remark must be Passed, Failed or Dropped');
      out.push({
        line, studentNo, fullName,
        prelim: pct(r[idx.prelim], 'Prelim'), midterm: pct(r[idx.midterm], 'Midterm'),
        prefinal: pct(r[idx.prefinal], 'Pre-final'), finals: pct(r[idx.finals], 'Finals'),
        finalPct: idx.finalPct >= 0 ? pct(r[idx.finalPct], 'Final Grade') : null,
        gp: Math.round(gp * 100) / 100, remark,
      });
    } catch (e) { errors.push({ line, reason: e.message }); }
  }
  return { rows: out, errors };
}

module.exports = { parseCSV, parseRegistrarCsv };
