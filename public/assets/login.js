'use strict';
const f = document.getElementById('f'), msg = document.getElementById('msg'), go = document.getElementById('go');
const u = document.getElementById('u'), p = document.getElementById('p');
const passwordStep = document.getElementById('password-step'), codeStep = document.getElementById('code-step');
const code = document.getElementById('code'), codeGo = document.getElementById('code-go');
const subtitle = document.getElementById('subtitle'), note = document.getElementById('note');
let challenge = sessionStorage.getItem('gp2faChallenge') || '';
const params = new URLSearchParams(location.search);
code.disabled = true; codeGo.disabled = true;

function showCode(message) {
  passwordStep.hidden = true; codeStep.hidden = false;
  u.disabled = true; p.disabled = true; code.disabled = false;
  go.disabled = true; codeGo.disabled = false;
  subtitle.textContent = 'Two-factor verification';
  note.textContent = 'Enter the six-digit code from your authenticator app, or one unused backup code.';
  if (message) { msg.className = 'msg ok'; msg.textContent = message; }
  code.focus();
}
if (params.get('reset') === '1') { msg.className = 'msg ok'; msg.textContent = 'Password updated. Sign in with your new password.'; }
if (params.get('twofa') === '1' && challenge) showCode('Password updated. Enter your authenticator code to finish signing in.');
if (params.get('forgot') === '1' || location.hash === '#forgot') showForgot();

function showForgot() {
  passwordStep.hidden = false; codeStep.hidden = true;
  subtitle.textContent = 'Instructor password recovery';
  u.disabled = false; p.hidden = true; p.disabled = true; code.disabled = true;
  go.disabled = false; codeGo.disabled = true;
  u.placeholder = 'Instructor username'; go.textContent = 'Send reset link';
  note.textContent = 'A link is sent only if your instructor account has a verified email. Students should ask their instructor to reset their account.';
  u.focus();
}

document.getElementById('forgot-link').addEventListener('click', () => { location.hash = 'forgot'; showForgot(); });

async function finish(data) {
  if (data.secondFactor) {
    challenge = data.challenge; sessionStorage.setItem('gp2faChallenge', challenge); showCode(); return;
  }
  sessionStorage.removeItem('gp2faChallenge');
  location.href = data.role === 'teacher' ? '/admin' : '/student';
}

f.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.className = 'msg'; msg.textContent = '';
  const forgot = location.hash === '#forgot' || params.get('forgot') === '1';
  const submitBtn = forgot ? go : (codeStep.hidden ? go : codeGo);
  submitBtn.disabled = true;
  try {
    let res, data;
    if (!codeStep.hidden) {
      res = await fetch('/api/login/2fa', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge, code: code.value.trim() }) });
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Could not verify that code.');
      await finish(data);
    } else if (forgot) {
      res = await fetch('/api/forgot-password', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.value.trim() }) });
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Could not send a reset link.');
      msg.className = 'msg ok'; msg.textContent = data.message;
    } else {
      res = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.value.trim(), password: p.value }) });
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Could not sign in.');
      await finish(data);
    }
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
  finally { go.disabled = false; codeGo.disabled = false; }
});
