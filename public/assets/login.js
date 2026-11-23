'use strict';
const f = document.getElementById('f'), msg = document.getElementById('msg'), go = document.getElementById('go');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.className = 'msg'; msg.textContent = ''; go.disabled = true;
  try {
    const res = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('u').value.trim(), password: document.getElementById('p').value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Could not sign in.');
    location.href = data.role === 'teacher' ? '/admin' : '/student';
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; go.disabled = false; }
});
