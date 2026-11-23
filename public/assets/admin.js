'use strict';
(async function () {
  const { h, api, icon, topbar, passwordDialog } = App;
  const me = await api('/api/me');
  document.getElementById('top').append(topbar(me, { menu: true }));
  if (me.mustChangePassword) await passwordDialog({ forced: true });

  const nav = document.getElementById('nav');
  const detail = document.getElementById('detail');
  const listEl = h('ul', { class: 'side-list' });
  const none = h('p', { class: 'nav-empty', hidden: true }, 'No subjects yet.');
  const newBtn = h('button', { class: 'nav-btn', type: 'button' }, icon('plus'), 'New subject');
  newBtn.addEventListener('click', openNew);
  nav.append(
    h('div', { class: 'nav-head' }, 'Subjects'),
    listEl, none, newBtn,
    h('div', { class: 'nav-foot' }, h('span', {}, 'Signed in as'), h('strong', {}, me.fullName)));

  let subjects = [], currentId = null, view = 'subject';
  const PERIODS = [['prelim', 'Prelim'], ['midterm', 'Midterm'], ['prefinal', 'Pre-Finals'], ['finals', 'Finals']];
  const fmt = v => (v == null ? '—' : Number(v).toFixed(2));
  const setCurrent = (el, active) => { if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); };
  const closeNav = () => { if (window.innerWidth < 900) document.body.classList.add('nav-collapsed'); };
  if (window.innerWidth < 900) document.body.classList.add('nav-collapsed');

  function renderSidebar() {
    listEl.replaceChildren(...subjects.map(s => {
      const btn = h('button', { type: 'button', class: 'side-item', onclick: () => openSubject(s.id) },
        h('span', { class: 'side-title' }, s.title),
        h('small', {}, [s.code, s.term, s.section, `${s.enrolled} student${s.enrolled === 1 ? '' : 's'}`].filter(Boolean).join(' · ')));
      setCurrent(btn, view === 'subject' && s.id === currentId);
      return h('li', {}, btn);
    }));
    none.hidden = subjects.length > 0;
    setCurrent(newBtn, view === 'new');
  }

  async function loadSubjects() {
    subjects = await api('/api/admin/subjects');
    renderSidebar();
  }

  function csvCell(v) { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function credentialsDialog(title, list) {
    const dlg = h('dialog', { class: 'wide' },
      h('div', { class: 'dh' }, title),
      h('div', { class: 'db' },
        h('p', {}, 'Give each student their temporary password privately. ', h('strong', {}, 'These passwords are shown only once'), ' and cannot be recovered — students must change them at first sign-in.'),
        h('div', { class: 'tablewrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Student ID', 'Name', 'Username', 'Temporary password'].map(t => h('th', {}, t)))),
          h('tbody', {}, list.map(c => h('tr', {}, h('td', {}, c.studentNo), h('td', {}, c.fullName), h('td', {}, c.username), h('td', {}, h('code', {}, c.tempPassword)))))))),
      h('div', { class: 'df' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => {
          const rows = [['Student ID', 'Name', 'Username', 'Temporary password'], ...list.map(c => [c.studentNo, c.fullName, c.username, c.tempPassword])];
          const url = URL.createObjectURL(new Blob([rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' }));
          const a = h('a', { href: url, download: 'student-credentials.csv' }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        } }, 'Download CSV'),
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'I have saved these')));
    document.body.append(dlg); dlg.showModal();
  }

  // Text field with an id/label; `span2` makes it full width in the form grid.
  function field(id, label, value, extra = {}, span2 = false) {
    const input = h('input', { id, type: 'text', value, ...extra });
    const wrap = h('div', { class: 'field' + (span2 ? ' span2' : '') }, h('label', { for: id }, label), input);
    return { input, wrap };
  }

  async function openSubject(id) {
    currentId = id; view = 'subject';
    await loadSubjects();
    const s = await api(`/api/admin/subjects/${id}`);
    renderSubject(s);
    closeNav();
  }

  function openNew() {
    currentId = null; view = 'new'; renderSidebar(); closeNav();
    const code = field('ns-code', 'Code', '', { maxlength: 20, placeholder: 'NET02', required: true });
    const section = field('ns-sec', 'Section (optional)', '', { maxlength: 20, placeholder: 'BSIT 3A' });
    const title = field('ns-title', 'Title', '', { maxlength: 80, placeholder: 'Networking 2', required: true }, true);
    const term = field('ns-term', 'School year & term', '', { maxlength: 40, placeholder: '2025-2026 1st Term', required: true }, true);
    const msg = h('p', { class: 'msg', role: 'alert' });
    const form = h('form', {},
      h('div', { class: 'form-grid' }, code.wrap, section.wrap, title.wrap, term.wrap),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'submit' }, 'Create subject')),
      msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = 'msg'; msg.textContent = '';
      try {
        const r = await api('/api/admin/subjects', { method: 'POST', body: {
          code: code.input.value, title: title.input.value, term: term.input.value, section: section.input.value } });
        await openSubject(r.id);
      } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    });
    detail.replaceChildren(
      h('section', { class: 'panel page-head' },
        h('div', {}, h('h1', { class: 'page-title' }, 'New subject'),
          h('p', { class: 'page-sub' }, 'Set up a subject, then import its Registrar Report and release periods.'))),
      h('section', { class: 'panel' }, form));
    code.input.focus();
  }

  function editSubject(s) {
    const code = field('ed-code', 'Code', s.code, { maxlength: 20, required: true });
    const section = field('ed-sec', 'Section (optional)', s.section || '', { maxlength: 20 });
    const title = field('ed-title', 'Title', s.title, { maxlength: 80, required: true }, true);
    const term = field('ed-term', 'School year & term', s.term, { maxlength: 40, required: true }, true);
    const msg = h('p', { class: 'msg', role: 'alert' });
    const form = h('form', { method: 'dialog', onsubmit: async (e) => {
      e.preventDefault();
      msg.className = 'msg'; msg.textContent = '';
      try {
        await api(`/api/admin/subjects/${s.id}`, { method: 'PUT', body: {
          code: code.input.value, title: title.input.value, term: term.input.value, section: section.input.value } });
        dlg.close(); dlg.remove();
        await openSubject(s.id);
      } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    } },
      h('div', { class: 'db' },
        h('div', { class: 'form-grid' }, code.wrap, section.wrap, title.wrap, term.wrap),
        h('p', { class: 'hint' }, 'Changing the code, term or section does not move students or grades. Grades still come from the imported CSV.'),
        msg),
      h('div', { class: 'df' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel'),
        h('button', { class: 'btn', type: 'submit' }, 'Save changes')));
    const dlg = h('dialog', { class: 'wide' }, h('div', { class: 'dh' }, 'Edit subject'), form);
    document.body.append(dlg);
    dlg.showModal();
    code.input.focus();
  }

  function renderSubject(s) {
    // --- release switches ---
    const relMsg = h('p', { class: 'msg', role: 'status' });
    const relBoxes = PERIODS.map(([key, label]) => {
      const cb = h('input', { type: 'checkbox', checked: s.released[key], onchange: async () => {
        relMsg.className = 'msg'; relMsg.textContent = 'Saving…';
        try { await api(`/api/admin/subjects/${s.id}/releases`, { method: 'PUT', body: { [key]: cb.checked } }); relMsg.className = 'msg ok'; relMsg.textContent = `${label} ${cb.checked ? 'released to students' : 'hidden from students'}.`; await openSubject(s.id); }
        catch (err) { cb.checked = !cb.checked; relMsg.className = 'msg err'; relMsg.textContent = err.message; }
      } });
      return h('label', {}, cb, label);
    });

    // --- import ---
    const file = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'Registrar Report CSV' });
    const report = h('div', {});
    const checkBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Check file');
    const importBtn = h('button', { class: 'btn', type: 'button', disabled: true }, 'Import');
    let csvText = '';
    file.addEventListener('change', () => { importBtn.disabled = true; report.replaceChildren(); csvText = ''; });
    const showResult = (r) => report.replaceChildren(
      h('div', { class: 'sum' }, h('span', {}, r.rows, ' ', h('em', {}, 'students in file')), h('span', {}, r.newStudents, ' ', h('em', {}, 'new')),
        h('span', {}, r.updatedEnrollments, ' ', h('em', {}, 'already enrolled (grades updated)')), h('span', {}, r.skipped.length, ' ', h('em', {}, 'skipped'))),
      r.renamed ? h('p', { class: 'hint' }, `${r.renamed} student name(s) differ from what the portal had and will be updated.`) : null,
      r.skipped.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Line'), h('th', {}, 'Why skipped'))),
        h('tbody', {}, r.skipped.map(k => h('tr', {}, h('td', {}, k.line), h('td', {}, k.reason)))))) : null);
    checkBtn.addEventListener('click', async () => {
      if (!file.files[0]) { report.replaceChildren(h('p', { class: 'msg err' }, 'Choose the Registrar Report CSV first.')); return; }
      try {
        csvText = await file.files[0].text();
        const r = await api(`/api/admin/subjects/${s.id}/import`, { method: 'POST', body: { csv: csvText, dryRun: true } });
        showResult(r); importBtn.disabled = r.rows === 0; importBtn.textContent = `Import ${r.rows} student${r.rows === 1 ? '' : 's'}`;
      } catch (err) { report.replaceChildren(h('p', { class: 'msg err' }, err.message)); importBtn.disabled = true; }
    });
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      try { const r = await api(`/api/admin/subjects/${s.id}/import`, { method: 'POST', body: { csv: csvText } }); await openSubject(s.id); document.getElementById('imp-done').textContent = `Imported ${r.rows} student(s).`; }
      catch (err) { report.replaceChildren(h('p', { class: 'msg err' }, err.message)); }
    });

    // --- students ---
    const noAccount = s.students.filter(x => !x.hasAccount).length;
    const resetBtn = (st) => h('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
      if (!confirm(`Reset the password for ${st.fullName}? Their current password and sessions stop working.`)) return;
      try { const c = await api(`/api/admin/students/${st.studentId}/reset-password`, { method: 'POST' }); credentialsDialog('New temporary password', [c]); }
      catch (err) { alert(err.message); }
    } }, 'Reset password');
    const headRow = h('tr', {},
      h('th', {}, 'Student ID'), h('th', {}, 'Name'),
      PERIODS.map(([k, l]) => h('th', { class: 'num' }, l)),
      h('th', { class: 'num' }, 'Final'), h('th', {}, 'Remark'), h('th', {}, 'Account'));
    const bodyRows = s.students.map(st => h('tr', {},
      h('td', {}, st.studentNo), h('td', {}, st.fullName),
      PERIODS.map(([k]) => h('td', { class: s.released[k] ? 'num' : 'num dim', title: s.released[k] ? '' : 'Hidden from students' }, fmt(st[k]))),
      h('td', { class: s.released.finals ? 'num' : 'num dim' }, fmt(st.finalGp)),
      h('td', {}, st.remark || '—'),
      h('td', {}, st.hasAccount ? resetBtn(st) : 'No account')));
    const studentsTable = s.students.length === 0
      ? h('p', { class: 'hint' }, 'No students yet. Import the Registrar Report above.')
      : h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, headRow), h('tbody', {}, bodyRows)));

    const acctBtn = h('button', { class: 'btn', type: 'button', disabled: noAccount === 0, onclick: async () => {
      try { const r = await api(`/api/admin/subjects/${s.id}/accounts`, { method: 'POST' }); await openSubject(s.id); if (r.created.length) credentialsDialog(`${r.created.length} account(s) created`, r.created); }
      catch (err) { alert(err.message); }
    } }, noAccount ? `Create accounts for ${noAccount} student${noAccount === 1 ? '' : 's'}` : 'All students have accounts');

    // --- activity ---
    const logBody = h('tbody', {});
    const logDetails = h('details', {}, h('summary', {}, 'Recent activity'), h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['When (UTC)', 'Action', 'Detail', 'From'].map(t => h('th', {}, t)))), logBody)));
    logDetails.addEventListener('toggle', async () => {
      if (!logDetails.open) return;
      const rows = await api('/api/admin/audit');
      logBody.replaceChildren(...rows.map(r => h('tr', {}, h('td', {}, r.at), h('td', {}, r.action), h('td', {}, r.detail || ''), h('td', {}, r.ip || ''))));
    });

    detail.replaceChildren(
      h('section', { class: 'panel page-head' },
        h('div', {},
          h('h1', { class: 'page-title' }, s.title),
          h('p', { class: 'page-sub' }, [s.code, s.term, s.section].filter(Boolean).join(' · ')),
          h('p', { class: 'hint' }, `${s.students.length} student${s.students.length === 1 ? '' : 's'} enrolled · Students see only what you release below.`)),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => editSubject(s) }, icon('edit'), 'Edit subject')),
      h('section', { class: 'panel' }, h('h3', {}, '1. Publish grades from the gradebook'),
        h('p', { class: 'hint' }, 'In the gradebook, open the section and click “Registrar Report (CSV)”, then upload that file here. Re-upload any time to update grades. Every student needs a Student ID in the gradebook.'),
        h('div', { class: 'row-actions' }, file, checkBtn, importBtn), h('p', { class: 'msg ok', id: 'imp-done' }), report),
      h('section', { class: 'panel' }, h('h3', {}, '2. Release periods to students'),
        h('div', { class: 'rel' }, relBoxes),
        h('p', { class: 'hint' }, 'Tick a period when you are ready for students to see it. The Final Grade appears only after all four periods are released. Greyed grades below are still hidden from students.'), relMsg),
      h('section', { class: 'panel' }, h('h3', {}, '3. Students and accounts'),
        h('div', { class: 'row-actions' }, acctBtn), h('p', { class: 'hint' }, 'Usernames are Student IDs. Each student gets a one-time temporary password.'), studentsTable),
      h('section', { class: 'panel' }, logDetails));
  }

  await loadSubjects();
  if (subjects.length) openSubject(subjects[0].id); else openNew();
})().catch(err => { if (err.message !== 'Signed out') console.error(err); });
