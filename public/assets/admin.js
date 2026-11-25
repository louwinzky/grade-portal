'use strict';
(async function () {
  const { h, api, icon, topbar, passwordDialog } = App;
  const me = await api('/api/me');
  document.getElementById('top').append(topbar(me, { menu: true }));
  if (me.mustChangePassword) await passwordDialog({ forced: true });

  const nav = document.getElementById('nav');
  const detail = document.getElementById('detail');
  const termSel = h('select', { id: 'admin-term', 'aria-label': 'School year and term' });
  const subjectSearch = h('input', { type: 'search', placeholder: 'Search subjects…', 'aria-label': 'Search subjects' });
  const listEl = h('ul', { class: 'side-list' });
  const none = h('p', { class: 'nav-empty', hidden: true }, 'No subjects yet.');
  const newBtn = h('button', { class: 'nav-btn', type: 'button' }, icon('plus'), 'New subject');
  newBtn.addEventListener('click', openNew);
  const teachersBtn = me.isOwner
    ? h('button', { class: 'nav-btn', type: 'button', onclick: openTeachers }, icon('users'), 'Instructors')
    : null;
  nav.append(
    h('div', { class: 'side-filters' },
      h('div', { class: 'side-label' }, 'School year & term'),
      h('div', { class: 'term-select' }, termSel),
      h('div', { class: 'side-search' }, subjectSearch)),
    h('div', { class: 'nav-head' }, 'Subjects'),
    listEl, none, newBtn,
    ...(teachersBtn ? [h('div', { class: 'nav-head' }, 'Administration'), teachersBtn] : []),
    h('div', { class: 'nav-foot' }, h('span', {}, 'Signed in as'),
      h('strong', {}, me.fullName + (me.isOwner ? ' · Owner' : ''))));

  let subjects = [], currentId = null, view = 'subject', currentTerm = '', setNewTerm = null, renderToken = 0;
  const matchesSearch = s => {
    const q = subjectSearch.value.trim().toLowerCase();
    return !q || [s.title, s.code, s.term, s.section].join(' ').toLowerCase().includes(q);
  };
  const termSubjects = () => subjects.filter(s => !currentTerm || s.term === currentTerm);
  const visibleSubjects = () => termSubjects().filter(matchesSearch);
  const PERIODS = [['prelim', 'Prelim'], ['midterm', 'Midterm'], ['prefinal', 'Pre-Finals'], ['finals', 'Finals']];
  const fmt = v => (v == null ? '—' : Number(v).toFixed(2));
  const setCurrent = (el, active) => { if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); };
  const closeNav = () => { if (window.innerWidth < 900) document.body.classList.add('nav-collapsed'); };
  if (window.innerWidth < 900) document.body.classList.add('nav-collapsed');

  function renderTermOptions() {
    const terms = [...new Set(subjects.map(s => s.term))].sort(compareTerms);
    if (currentTerm && !terms.includes(currentTerm)) currentTerm = '';
    termSel.replaceChildren(h('option', { value: '' }, 'All terms'), ...terms.map(t => h('option', { value: t }, t)));
    termSel.value = currentTerm;
  }
  termSel.addEventListener('change', () => {
    currentTerm = termSel.value;
    if (view === 'new' && setNewTerm && currentTerm) setNewTerm(currentTerm);
    if (view === 'subject') {
      const inTerm = termSubjects();   // don't let a search query force a different subject open
      if (inTerm.length && !inTerm.some(s => s.id === currentId)) { openSubject(inTerm[0].id); return; }
      if (!inTerm.length) { openNew(); return; }
    }
    renderSidebar();
  });
  subjectSearch.addEventListener('input', renderSidebar);

  const SEM_ORDER = { '1st Semester': 1, '2nd Semester': 2, 'Summer': 3 };
  function termSortKey(term) {
    const m = /^(\d{4})-\d{4}\s*·\s*(.*)$/.exec(term);
    return m ? [Number(m[1]), SEM_ORDER[m[2].trim()] ?? 99, m[2]] : [0, 99, term];
  }
  function compareTerms(a, b) {
    const ka = termSortKey(a), kb = termSortKey(b);
    if (ka[0] !== kb[0]) return kb[0] - ka[0];   // latest school year first
    if (ka[1] !== kb[1]) return ka[1] - kb[1];   // 1st, 2nd, Summer
    return String(ka[2]).localeCompare(String(kb[2]));
  }
  function subjectItem(s) {
    const btn = h('button', { type: 'button', class: 'side-item', onclick: () => openSubject(s.id) },
      h('span', { class: 'side-title' }, s.title),
      h('small', {}, [s.code, s.term, s.section, `${s.enrolled} student${s.enrolled === 1 ? '' : 's'}`].filter(Boolean).join(' · ')));
    setCurrent(btn, view === 'subject' && s.id === currentId);
    return h('li', {}, btn);
  }

  function renderSidebar() {
    const visible = visibleSubjects();
    if (currentTerm) {
      listEl.replaceChildren(...visible.map(subjectItem));
    } else {
      // All terms: group under term headings, newest school year first.
      const groups = new Map();
      for (const s of visible) {
        if (!groups.has(s.term)) groups.set(s.term, []);
        groups.get(s.term).push(s);
      }
      listEl.replaceChildren(...[...groups.keys()].sort(compareTerms).flatMap(term => [
        h('li', { class: 'side-term' }, term),
        ...groups.get(term).map(subjectItem),
      ]));
    }
    none.hidden = visible.length > 0;
    none.textContent = subjects.length === 0 ? 'No subjects yet.'
      : subjectSearch.value.trim() ? 'No subjects match your search.' : 'No subjects in this term.';
    setCurrent(newBtn, view === 'new');
    if (teachersBtn) setCurrent(teachersBtn, view === 'teachers');
  }

  async function loadSubjects() {
    subjects = await api('/api/admin/subjects');
    renderTermOptions();
    renderSidebar();
  }

  function csvCell(v) { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function credentialsDialog(title, list, { idLabel = 'Student ID', filename = 'student-credentials.csv' } = {}) {
    const dlg = h('dialog', { class: 'wide' },
      h('div', { class: 'dh' }, title),
      h('div', { class: 'db' },
        h('p', {}, 'Give each account holder their temporary password privately. ', h('strong', {}, 'These passwords are shown only once'), ' and cannot be recovered — they must change them at first sign-in.'),
        h('div', { class: 'tablewrap' }, h('table', {},
          h('thead', {}, h('tr', {}, [idLabel, 'Name', 'Username', 'Temporary password'].map(t => h('th', {}, t)))),
          h('tbody', {}, list.map(c => h('tr', {}, h('td', {}, c.studentNo), h('td', {}, c.fullName), h('td', {}, c.username), h('td', {}, h('code', {}, c.tempPassword)))))))),
      h('div', { class: 'df' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => {
          const rows = [[idLabel, 'Name', 'Username', 'Temporary password'], ...list.map(c => [c.studentNo, c.fullName, c.username, c.tempPassword])];
          const url = URL.createObjectURL(new Blob([rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' }));
          const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        } }, 'Download CSV'),
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'I have saved these')));
    document.body.append(dlg); dlg.showModal();
  }

  // Generic confirmation used by the instructor-management actions.
  function confirmDialog(title, message, confirmLabel, onConfirm, danger = true) {
    const msg = h('p', { class: 'msg', role: 'alert' });
    const btn = h('button', { class: 'btn' + (danger ? ' danger-solid' : ''), type: 'button' }, confirmLabel);
    const dlg = h('dialog', { class: 'wide' },
      h('div', { class: 'dh' }, title),
      h('div', { class: 'db' }, message, msg),
      h('div', { class: 'df' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel'),
        btn));
    btn.addEventListener('click', async () => {
      btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Working…';
      try { await onConfirm(); dlg.close(); dlg.remove(); await openTeachers(); }
      catch (err) { btn.disabled = false; msg.className = 'msg err'; msg.textContent = err.message; }
    });
    document.body.append(dlg); dlg.showModal();
  }

  function resetTeacherDialog(t) {
    confirmDialog('Reset instructor password',
      h('p', {}, 'Generate a new temporary password for ', h('strong', {}, t.fullName), '?', h('br'),
        h('span', { class: 'page-sub' }, '@' + t.username), h('br'),
        h('span', { class: 'hint' }, 'Their current sessions will be signed out and they must choose a new password at next sign-in.')),
      'Reset password', async () => {
        const r = await api(`/api/admin/teachers/${t.id}/reset-password`, { method: 'POST' });
        credentialsDialog('Temporary password',
          [{ studentNo: r.username, fullName: r.fullName, username: r.username, tempPassword: r.tempPassword }],
          { idLabel: 'Username', filename: 'instructor-credentials.csv' });
      }, false);
  }

  function createTeacherDialog() {
    const u = field('nt-user', 'Username', '', { maxlength: 64, placeholder: 'reyes', required: true });
    const n = field('nt-name', 'Full name', '', { maxlength: 80, placeholder: 'Prof. Reyes', required: true }, true);
    const owner = h('input', { type: 'checkbox', id: 'nt-owner' });
    const msg = h('p', { class: 'msg', role: 'alert' });
    const form = h('form', { method: 'dialog', onsubmit: async (e) => {
      e.preventDefault();
      msg.className = 'msg'; msg.textContent = '';
      try {
        const r = await api('/api/admin/teachers', { method: 'POST', body: {
          username: u.input.value, fullName: n.input.value, owner: owner.checked } });
        dlg.close(); dlg.remove();
        credentialsDialog('Instructor account created',
          [{ studentNo: r.username, fullName: r.fullName, username: r.username, tempPassword: r.tempPassword }],
          { idLabel: 'Username', filename: 'instructor-credentials.csv' });
        await openTeachers();
      } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    } },
      h('div', { class: 'db' },
        h('div', { class: 'form-grid' }, u.wrap, n.wrap),
        h('label', { class: 'check', for: 'nt-owner' }, owner, ' Grant owner access (can create and manage instructor accounts)'),
        h('p', { class: 'hint' }, 'A temporary password will be generated and shown only once.'), msg),
      h('div', { class: 'df' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel'),
        h('button', { class: 'btn', type: 'submit' }, 'Create instructor')));
    const dlg = h('dialog', { class: 'wide' }, h('div', { class: 'dh' }, 'New instructor'), form);
    document.body.append(dlg); dlg.showModal(); u.input.focus();
  }

  async function openTeachers() {
    const token = ++renderToken;
    currentId = null; view = 'teachers'; setNewTerm = null; renderSidebar(); closeNav();
    const rows = await api('/api/admin/teachers');
    if (token !== renderToken) return;
    const search = h('input', { type: 'search', placeholder: 'Filter by name or username…', 'aria-label': 'Filter instructors' });
    const tbody = h('tbody', {});
    const refresh = () => {
      const q = search.value.trim().toLowerCase();
      tbody.replaceChildren(...rows.filter(t => !q || `${t.fullName} ${t.username}`.toLowerCase().includes(q)).map(t => h('tr', {},
        h('td', {}, t.fullName),
        h('td', {}, '@' + t.username),
        h('td', {}, h('span', { class: 'badge ' + (t.active ? 'ok' : 'off') }, t.active ? 'Active' : 'Disabled')),
        h('td', {}, h('span', { class: 'badge ' + (t.isOwner ? 'owner' : '') }, t.isOwner ? 'Owner' : 'Instructor')),
        h('td', { class: 'num' }, t.subjectCount),
        h('td', {}, t.lastLogin || '—'),
        h('td', {}, h('div', { class: 'row-actions tight' },
          t.id === me.id
            ? h('button', { class: 'btn ghost small', type: 'button',
                onclick: async () => { await passwordDialog({ forced: false }); } }, 'Change password')
            : h('button', { class: 'btn ghost small', type: 'button', onclick: () => resetTeacherDialog(t) }, 'Reset password'),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => confirmDialog(
            t.active ? 'Disable instructor' : 'Enable instructor',
            h('p', {}, t.active ? 'Disable ' : 'Enable ', h('strong', {}, t.fullName), '?', h('br'),
              h('span', { class: 'page-sub' }, '@' + t.username), h('br'),
              h('span', { class: 'hint' }, t.active
                ? 'They will be signed out immediately and cannot sign in until enabled again.'
                : 'They will be able to sign in again with their existing password.')),
            t.active ? 'Disable' : 'Enable',
            () => api(`/api/admin/teachers/${t.id}/active`, { method: 'PUT', body: { active: !t.active } }), t.active) },
            t.active ? 'Disable' : 'Enable'),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => confirmDialog(
            t.isOwner ? 'Remove owner access' : 'Grant owner access',
            h('p', {}, t.isOwner ? 'Remove owner access for ' : 'Make ', h('strong', {}, t.fullName),
              t.isOwner ? '?' : ' an owner?', h('br'), h('span', { class: 'page-sub' }, '@' + t.username), h('br'),
              h('span', { class: 'hint' }, t.isOwner
                ? 'They keep their subjects but lose access to instructor management.'
                : 'They will be able to create and manage instructor accounts.')),
            t.isOwner ? 'Remove owner' : 'Grant owner',
            () => api(`/api/admin/teachers/${t.id}/owner`, { method: 'PUT', body: { owner: !t.isOwner } }), false) },
            t.isOwner ? 'Remove owner' : 'Make owner'))))));
    };
    search.addEventListener('input', refresh);
    refresh();
    detail.replaceChildren(
      h('section', { class: 'panel page-head' },
        h('div', {}, h('h1', { class: 'page-title' }, 'Instructors'),
          h('p', { class: 'page-sub' }, `${rows.length} instructor account${rows.length === 1 ? '' : 's'} · Owners can create, reset and disable accounts.`)),
        h('button', { class: 'btn', type: 'button', onclick: createTeacherDialog }, icon('plus'), 'New instructor')),
      h('section', { class: 'panel' },
        h('div', { class: 'filter-row' }, search),
        h('div', { class: 'tablewrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Name', 'Username', 'Status', 'Access', 'Subjects', 'Last login', 'Actions'].map(x => h('th', {}, x)))),
          tbody)),
        h('p', { class: 'hint' }, 'Temporary passwords are shown once. Instructors choose their own password at first sign-in. ',
          'To change your own password use Change password in the account menu or on your row — resetting yourself would sign you out before you could copy the new password. At least one active owner is kept.')));
  }

  // Text field with an id/label; `span2` makes it full width in the form grid.
  function field(id, label, value, extra = {}, span2 = false) {
    const input = h('input', { id, type: 'text', value, ...extra });
    const wrap = h('div', { class: 'field' + (span2 ? ' span2' : '') }, h('label', { for: id }, label), input);
    return { input, wrap };
  }

  // School year + term picker. Produces the canonical "YYYY-YYYY · Semester" string the rest of the
  // app expects. Anything that does not match that shape falls back to a plain "Other" term field,
  // so older/custom terms can still be read and saved without being mangled.
  let pickerSeq = 0;
  function termPicker(value = '') {
    const seq = ++pickerSeq;
    const yearId = `tp-year-${seq}`, semId = `tp-sem-${seq}`, customId = `tp-custom-${seq}`;
    // Academic year starts in June: Jan-May still belongs to the previous year's intake.
    const today = new Date();
    const start = today.getMonth() >= 5 ? today.getFullYear() : today.getFullYear() - 1;
    const years = [`${start - 1}-${start}`, `${start}-${start + 1}`, `${start + 1}-${start + 2}`];
    const SEMESTERS = ['1st Semester', '2nd Semester', 'Summer'];

    const yearSel = h('select', { id: yearId, 'aria-label': 'School year' }, ...years.map(y => h('option', { value: y }, y)));
    const semSel = h('select', { id: semId, 'aria-label': 'Term' },
      ...SEMESTERS.map(s => h('option', { value: s }, s)), h('option', { value: '__custom__' }, 'Other (type below)'));
    const custom = h('input', { id: customId, type: 'text', maxlength: 40, placeholder: 'e.g. 2026-2027 · 1st Trimester' });
    const customRow = h('div', { class: 'field span2', hidden: true },
      h('label', { for: customId }, 'Custom term'), custom);
    let lastSemester = SEMESTERS[0];

    function setValue(raw) {
      const str = String(raw || '').trim();
      const m = /^(\d{4}-\d{4})\s*·\s*(.*)$/.exec(str);
      if (m && SEMESTERS.includes(m[2].trim())) {
        if (!years.includes(m[1])) { years.push(m[1]); years.sort(); yearSel.append(h('option', { value: m[1] }, m[1])); }
        yearSel.value = m[1];
        semSel.value = m[2].trim();
        lastSemester = semSel.value;
        custom.value = '';
      } else if (str) {
        semSel.value = '__custom__';
        custom.value = str;                       // keep legacy/custom terms verbatim
      } else {
        yearSel.value = `${start}-${start + 1}`;
        semSel.value = SEMESTERS[0];
        lastSemester = SEMESTERS[0];
        custom.value = '';
      }
      customRow.hidden = semSel.value !== '__custom__';
    }
    semSel.addEventListener('change', () => {
      const isCustom = semSel.value === '__custom__';
      if (isCustom) { if (!custom.value) custom.value = `${yearSel.value} · ${lastSemester}`; }
      else { lastSemester = semSel.value; custom.value = ''; }
      customRow.hidden = !isCustom;
      if (isCustom) custom.focus();
    });
    setValue(value);

    return {
      wrap: h('div', { class: 'term-picker' },
        h('div', { class: 'field' }, h('label', { for: yearId }, 'School year'), yearSel),
        h('div', { class: 'field' }, h('label', { for: semId }, 'Term'), semSel),
        customRow),
      setValue,
      value: () => (semSel.value === '__custom__' ? custom.value.trim() : `${yearSel.value} · ${semSel.value}`),
    };
  }

  // Delete a subject after an explicit confirmation; grades are removed with it (ON DELETE CASCADE).
  function deleteSubject(s) {
    const msg = h('p', { class: 'msg', role: 'alert' });
    const confirmBtn = h('button', { class: 'btn danger-solid', type: 'button' }, icon('trash'), 'Delete subject');
    const dlg = h('dialog', { class: 'wide' },
      h('div', { class: 'dh' }, 'Delete subject'),
      h('div', { class: 'db' },
        h('p', {}, 'Permanently delete ', h('strong', {}, s.title), '?',
          h('br'), h('span', { class: 'page-sub' }, [s.code, s.term, s.section].filter(Boolean).join(' · '))),
        h('p', { class: 'hint' }, `This removes ${s.students.length} enrolled student grade record${s.students.length === 1 ? '' : 's'} for this subject. Student accounts and other subjects are not affected. This cannot be undone.`),
        msg),
      h('div', { class: 'df' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel'),
        confirmBtn));
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      msg.className = 'msg'; msg.textContent = 'Deleting…';
      try {
        await api(`/api/admin/subjects/${s.id}`, { method: 'DELETE' });
        dlg.close(); dlg.remove();
        subjects = subjects.filter(x => x.id !== s.id);
        if (currentTerm && !subjects.some(x => x.term === currentTerm)) currentTerm = '';
        currentId = null;
        await loadSubjects();
        const visible = visibleSubjects();
        if (visible.length) await openSubject(visible[0].id); else openNew();
      } catch (err) {
        confirmBtn.disabled = false;
        msg.className = 'msg err'; msg.textContent = err.message;
      }
    });
    document.body.append(dlg); dlg.showModal();
  }

  async function openSubject(id) {
    const token = ++renderToken;
    currentId = id; view = 'subject'; setNewTerm = null;
    await loadSubjects();
    if (token !== renderToken) return;
    const s = await api(`/api/admin/subjects/${id}`);
    if (token !== renderToken) return;
    renderSubject(s);
    closeNav();
  }

  function openNew() {
    ++renderToken;
    currentId = null; view = 'new'; renderSidebar(); closeNav();
    const code = field('ns-code', 'Code', '', { maxlength: 20, placeholder: 'NET02', required: true });
    const section = field('ns-sec', 'Section (optional)', '', { maxlength: 20, placeholder: 'BSIT 3A' });
    const title = field('ns-title', 'Title', '', { maxlength: 80, placeholder: 'Networking 2', required: true }, true);
    const term = termPicker(currentTerm);
    setNewTerm = term.setValue;
    const msg = h('p', { class: 'msg', role: 'alert' });
    const form = h('form', {},
      h('div', { class: 'form-grid' }, code.wrap, section.wrap, title.wrap, term.wrap),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'submit' }, 'Create subject')),
      msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = 'msg'; msg.textContent = '';
      const termValue = term.value();
      if (!termValue) { msg.className = 'msg err'; msg.textContent = 'Enter a school year and term.'; return; }
      try {
        const r = await api('/api/admin/subjects', { method: 'POST', body: {
          code: code.input.value, title: title.input.value, term: termValue, section: section.input.value } });
        currentTerm = termValue;
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
    const term = termPicker(s.term);
    const msg = h('p', { class: 'msg', role: 'alert' });
    const form = h('form', { method: 'dialog', onsubmit: async (e) => {
      e.preventDefault();
      msg.className = 'msg'; msg.textContent = '';
      const termValue = term.value();
      if (!termValue) { msg.className = 'msg err'; msg.textContent = 'Enter a school year and term.'; return; }
      try {
        await api(`/api/admin/subjects/${s.id}`, { method: 'PUT', body: {
          code: code.input.value, title: title.input.value, term: termValue, section: section.input.value } });
        dlg.close(); dlg.remove();
        if (currentTerm) currentTerm = termValue;
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
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn ghost', type: 'button', onclick: () => editSubject(s) }, icon('edit'), 'Edit subject'),
          h('button', { class: 'btn danger', type: 'button', onclick: () => deleteSubject(s) }, icon('trash'), 'Delete'))),
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
  if (subjects.length) await openSubject(subjects[0].id); else openNew();
})().catch(err => { if (err.message !== 'Signed out') console.error(err); });
