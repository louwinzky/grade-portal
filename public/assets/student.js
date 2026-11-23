'use strict';
(async function () {
  const { h, api, icon, wordmark, avatarMenu, passwordDialog } = App;
  const me = await api('/api/me');

  // ---------- top bar + sidebar ----------
  const nav = document.getElementById('nav');
  const burger = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Show or hide menu', 'aria-controls': 'nav' }, icon('menu'));
  burger.addEventListener('click', () => document.body.classList.toggle('nav-collapsed'));
  document.getElementById('top').append(burger, wordmark(), h('span', { class: 'spacer' }), avatarMenu(me));
  if (window.innerWidth < 900) document.body.classList.add('nav-collapsed');

  const ITEMS = [
    { head: 'Information' },
    { id: 'grades', label: 'Grades', icon: 'star' },
    { head: 'Others' },
    { id: 'faq', label: 'FAQs', icon: 'help' },
    { id: 'privacy', label: 'Privacy Notice', icon: 'shield' },
  ];
  ITEMS.forEach(i => nav.append(i.head
    ? h('div', { class: 'nav-head' }, i.head)
    : h('a', { class: 'nav-item', href: '#' + i.id, 'data-view': i.id }, icon(i.icon), i.label)));

  function showView() {
    const id = ['grades', 'faq', 'privacy'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'grades';
    for (const v of ['grades', 'faq', 'privacy']) document.getElementById('view-' + v).hidden = v !== id;
    nav.querySelectorAll('.nav-item').forEach(a => { if (a.dataset.view === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (window.innerWidth < 900) document.body.classList.add('nav-collapsed');
  }
  window.addEventListener('hashchange', showView);
  showView();

  // ---------- static help pages ----------
  const SCALE = [['97 – 100', '1.00'], ['94 – 96', '1.25'], ['91 – 93', '1.50'], ['88 – 90', '1.75'], ['85 – 87', '2.00'],
    ['82 – 84', '2.25'], ['79 – 81', '2.50'], ['76 – 78', '2.75'], ['75', '3.00'], ['Below 75', '5.00']];
  document.getElementById('view-faq').append(
    h('h2', {}, 'Frequently asked questions'),
    h('h3', {}, 'Why does a grading period show “—”?'), h('p', {}, 'Your instructor has not released that period yet. It will appear here as soon as it is released.'),
    h('h3', {}, 'Why is my Final Grade not showing?'), h('p', {}, 'The Final Grade appears after all four grading periods have been released.'),
    h('h3', {}, 'How is my grade computed?'), h('p', {}, 'Your instructor computes your grades from your graded work. This portal only displays the results; ask your instructor if you want to review how a grade was computed.'),
    h('h3', {}, 'What do the Final Grade numbers mean?'),
    h('p', {}, 'Final Grades use a 1.00 – 5.00 scale where 1.00 is the highest, 3.00 is the lowest passing grade, and 5.00 is failing. Period grades above are percentages.'),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Percentage'), h('th', { class: 'num' }, 'Final Grade'))),
      h('tbody', {}, SCALE.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', { class: 'num' }, b))))),
    h('h3', {}, 'I forgot my password.'), h('p', {}, 'Ask your instructor to reset it. You will be given a temporary password and asked to choose a new one when you sign in.'),
    h('h3', {}, 'Something looks wrong.'), h('p', {}, 'Tell your instructor. Grades here are published by your instructor, who can correct and re-publish them.'));

  document.getElementById('view-privacy').append(
    h('h2', {}, 'Privacy notice'),
    h('p', {}, 'This portal exists so you can view your own grades.'),
    h('h3', {}, 'What is stored'),
    h('ul', {}, h('li', {}, 'Your name and student number.'),
      h('li', {}, 'The Prelim, Midterm, Pre Finals and Finals results, the Final Grade and the remark that your instructor publishes for subjects you are enrolled in.'),
      h('li', {}, 'Sign-in records (date, time and network address) and password changes, kept for security.'),
      h('li', {}, 'Your password, only in scrambled (hashed) form. No one can read it.')),
    h('h3', {}, 'What is not stored'), h('p', {}, 'Individual quiz, task or exam scores and attendance are not kept in this portal.'),
    h('h3', {}, 'Who can see it'), h('p', {}, 'You, your instructor for each subject, and the administrators who maintain the server. Other students cannot see your grades.'),
    h('h3', {}, 'Your choices'), h('p', {}, 'To ask about, correct or remove your information, contact your instructor.'));

  // ---------- grades ----------
  if (me.mustChangePassword) await passwordDialog({ forced: true });
  const { subjects } = await api('/api/student/grades');

  const termSel = document.getElementById('term'), cards = document.getElementById('cards'), empty = document.getElementById('empty');
  [...new Set(subjects.map(s => s.term))].forEach(t => termSel.append(h('option', { value: t }, t)));

  const fmt = v => (v == null ? '—' : Number(v).toFixed(2));
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getDate()} ${MON[d.getMonth()]}, ${d.getFullYear()}`; };
  // Simple average of released Final Grades (dropped subjects excluded). Not a registrar GWA: it only knows what is published here.
  const avg = list => {
    const v = list.filter(s => s.finalVisible && s.remark !== 'Dropped').map(s => s.finalGrade);
    return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : '—';
  };

  function card(s) {
    const final = s.finalVisible
      ? h('div', { class: 'final' }, h('span', { class: 'pill' }, 'Final Grade'), h('span', { class: `chip ${s.remark}` }, s.remark), h('span', { class: 'score' }, fmt(s.finalGrade)))
      : h('div', { class: 'final' }, h('span', { class: 'pill' }, 'Final Grade'), h('span', { class: 'wait' }, 'Shown once all grading periods are released'));
    return h('article', { class: 'subject' },
      h('header', {}, h('h2', {}, s.title), h('div', { class: 'sub' }, [s.instructor, fmtDate(s.updatedAt)].filter(Boolean).join(' • '))),
      h('div', { class: 'sbody' },
        h('div', { class: 'periods' },
          s.periods.map(p => h('div', { class: 'lbl' }, p.label)),
          s.periods.map(p => h('div', { class: 'val' + (p.released ? '' : ' pending'), title: p.released ? '' : 'Not yet released' }, fmt(p.value)))),
        final));
  }
  function render() {
    const list = subjects.filter(s => s.term === termSel.value);
    cards.replaceChildren(...list.map(card));
    empty.hidden = list.length > 0;
    document.getElementById('level').textContent = [...new Set(list.map(s => s.section).filter(Boolean))].join(', ') || 'My Grades';
    document.getElementById('gwa').replaceChildren(
      'Term Avg: ', h('b', {}, avg(list)), ' | Overall Avg: ', h('b', {}, avg(subjects)));
    document.getElementById('gwa').title = 'Simple average of the Final Grades released to you in this portal';
  }
  termSel.addEventListener('change', render);
  render();
})().catch(err => {
  if (err.message === 'Signed out') return;
  const e = document.getElementById('empty'); e.hidden = false; e.textContent = err.message;
});
