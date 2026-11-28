'use strict';
const msg = document.getElementById('msg'), go = document.getElementById('go');
const token = new URLSearchParams(location.search).get('token') || '';
async function verify() {
  if (!token) { msg.textContent = 'This verification link is missing its token.'; return; }
  try {
    const res = await fetch('/api/me/email/verify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Could not verify your email.');
    msg.className = 'msg ok'; msg.textContent = 'Email verified. Password recovery is now enabled for your account.';
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; go.hidden = false; }
}
go.addEventListener('click', verify);
verify();
