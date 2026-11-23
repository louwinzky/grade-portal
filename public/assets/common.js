'use strict';
(function () {
  // Tiny DOM helper. All data is inserted with textContent / text nodes, never innerHTML.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const unsafe = method !== 'GET';
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: unsafe ? { 'Content-Type': 'application/json' } : {},
      body: unsafe ? JSON.stringify(body === undefined ? {} : body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* no body */ }
    if (res.status === 401 && !location.pathname.startsWith('/login')) { location.href = '/login'; throw new Error('Signed out'); }
    if (!res.ok) { const e = new Error((data && data.message) || 'Request failed'); e.status = res.status; e.code = data && data.error; throw e; }
    return data;
  }

  // Static outline icons (24px grid). The strings are constants, never user data.
  const ICONS = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    star: '<path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1.1.9-1.1 1.7"/><circle cx="12" cy="17" r=".5"/>',
    shield: '<path d="M12 3l7 3v5.5c0 4.3-2.9 7.7-7 9.5-4.1-1.8-7-5.2-7-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
    key: '<circle cx="8" cy="15" r="3.6"/><path d="M10.6 12.4L20 3M16.5 6.5l2.8 2.8"/>',
    logout: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/>',
  };
  function icon(name) {
    const span = document.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
    return span;
  }

  const wordmark = () => h('a', { class: 'wordmark', href: '/' }, 'grade', h('span', { class: 'gold' }, 'portal'));

  const initials = (name) => {
    const t = String(name).replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    return ((t[0] || '?')[0] + (t[1] ? t[1][0] : '')).toUpperCase();
  };
  async function signOut() {
    try { await api('/api/logout', { method: 'POST' }); } finally { location.href = '/login'; }
  }

  // Round avatar button with a small account menu (change password / sign out)
  function avatarMenu(me) {
    const btn = h('button', { class: 'avatar', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Account menu' }, initials(me.fullName));
    const menu = h('div', { class: 'menu', role: 'menu', hidden: true },
      h('div', { class: 'menu-head' }, h('strong', {}, me.fullName), h('span', {}, me.role === 'teacher' ? 'Instructor' : `Student no. ${me.username}`)),
      h('button', { class: 'menu-item', role: 'menuitem', type: 'button', onclick: () => { close(); passwordDialog({ forced: false }); } }, icon('key'), 'Change password'),
      h('button', { class: 'menu-item', role: 'menuitem', type: 'button', onclick: signOut }, icon('logout'), 'Sign out'));
    const wrap = h('div', { class: 'menu-wrap' }, btn, menu);
    function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('button').focus();
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
    return wrap;
  }

  // Instructor-page header. Pass { menu: true } when the page has a collapsible sidebar.
  function topbar(me, { menu = false } = {}) {
    const bar = h('div', { class: 'topbar' });
    if (menu) {
      const btn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Show or hide menu', 'aria-controls': 'nav' }, icon('menu'));
      btn.addEventListener('click', () => document.body.classList.toggle('nav-collapsed'));
      bar.append(btn);
    }
    bar.append(wordmark(), h('span', { class: 'tag' }, 'Instructor'), h('span', { class: 'spacer' }), avatarMenu(me));
    return bar;
  }

  // Returns a promise that resolves once the password has been changed (or the dialog dismissed when not forced)
  function passwordDialog({ forced }) {
    return new Promise(resolve => {
      const cur = h('input', { type: 'password', autocomplete: 'current-password', id: 'pw-cur' });
      const nw = h('input', { type: 'password', autocomplete: 'new-password', id: 'pw-new' });
      const cf = h('input', { type: 'password', autocomplete: 'new-password', id: 'pw-cf' });
      const msg = h('p', { class: 'msg', role: 'alert' });
      const dlg = h('dialog', {},
        h('div', { class: 'dh' }, forced ? 'Choose a new password' : 'Change password'),
        h('form', { method: 'dialog', onsubmit: async (e) => {
          e.preventDefault();
          msg.className = 'msg'; msg.textContent = '';
          if (nw.value !== cf.value) { msg.className = 'msg err'; msg.textContent = 'New passwords do not match.'; return; }
          try {
            await api('/api/change-password', { method: 'POST', body: { current: cur.value, next: nw.value } });
            dlg.close(); dlg.remove(); resolve(true);
          } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
        } },
          h('div', { class: 'db' },
            forced ? h('p', {}, 'You are using a temporary password. Please choose your own before continuing.') : null,
            h('div', { class: 'field' }, h('label', { for: 'pw-cur' }, forced ? 'Temporary password' : 'Current password'), cur),
            h('div', { class: 'field' }, h('label', { for: 'pw-new' }, 'New password'), nw),
            h('div', { class: 'field' }, h('label', { for: 'pw-cf' }, 'Confirm new password'), cf),
            msg),
          h('div', { class: 'df' },
            forced ? null : h('button', { class: 'btn ghost', type: 'button', onclick: () => { dlg.close(); dlg.remove(); resolve(false); } }, 'Cancel'),
            h('button', { class: 'btn', type: 'submit' }, 'Save password'))));
      if (forced) dlg.addEventListener('cancel', e => e.preventDefault());   // Esc can't skip it
      document.body.append(dlg);
      dlg.showModal();
      cur.focus();
    });
  }

  window.App = { h, api, icon, wordmark, avatarMenu, topbar, passwordDialog };
})();
