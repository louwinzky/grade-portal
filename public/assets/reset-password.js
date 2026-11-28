'use strict';
const f = document.getElementById('f'), msg = document.getElementById('msg'), go = document.getElementById('go');
const token = new URLSearchParams(location.search).get('token') || '';
if (!token) { msg.className = 'msg err'; msg.textContent = 'This reset link is missing its token.'; go.disabled = true; }
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = document.getElementById('pw').value, cf = document.getElementById('cf').value;
  msg.className = 'msg'; msg.textContent = '';
  if (pw !== cf) { msg.className = 'msg err'; msg.textContent = 'Passwords do not match.'; return; }
  go.disabled = true;
  try {
    const res = await fetch('/api/reset-password', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: pw }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Could not reset the password.');
    if (data.challenge) {
      sessionStorage.setItem('gp2faChallenge', data.challengeToken);
      location.href = '/login?twofa=1';
    } else {
      location.href = '/login?reset=1';
    }
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; go.disabled = false; }
});
