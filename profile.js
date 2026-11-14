// Profil (konto zapisane na tym urządzeniu) + logowanie przez lichess (OAuth PKCE, bez hasła w aplikacji).
let A;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CLIENT_ID = 'analiza-szachowa';
const SCOPES = 'board:play challenge:read challenge:write puzzle:read study:read';

const DEFAULT = { name: '', avatar: '', chesscom: '', lichess: '', rating: 1200, games: 0, created: 0 };
export function profile() { return { ...DEFAULT, ...A.store.get('profile', {}) }; }
export function saveProfile(p) { A.store.set('profile', p); renderBadge(); }

export function lichessToken() { return A.store.get('lichessOAuth', '') || ''; }
let liUserCache = null;
export async function lichessUser() {
  if (liUserCache) return liUserCache;
  const r = await fetch('https://lichess.org/api/account', { headers: { Authorization: 'Bearer ' + lichessToken() } });
  if (!r.ok) throw new Error('lichess ' + r.status);
  liUserCache = (await r.json()).username;
  return liUserCache;
}

// ---- OAuth PKCE
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function redirectUri() { return location.origin + location.pathname; }
async function loginLichess() {
  if (!crypto.subtle) return A.toast('Logowanie działa na https albo localhost (nie przez adres IP w sieci).', 5000);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem('oauth', JSON.stringify({ verifier, state }));
  const u = new URL('https://lichess.org/oauth');
  u.search = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri(), code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state }).toString();
  location.href = u.toString();
}
async function finishLogin() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code'); const state = q.get('state');
  if (!code) return;
  history.replaceState(null, '', redirectUri());
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem('oauth') || '{}'); } catch {}
  if (!saved.verifier || saved.state !== state) return A.toast('Logowanie przerwane – spróbuj jeszcze raz.');
  const r = await fetch('https://lichess.org/api/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: saved.verifier, redirect_uri: redirectUri(), client_id: CLIENT_ID }),
  });
  sessionStorage.removeItem('oauth');
  if (!r.ok) return A.toast('Lichess nie wydał tokenu (' + r.status + ').');
  const j = await r.json();
  A.store.set('lichessOAuth', j.access_token);
  liUserCache = null;
  const name = await lichessUser().catch(() => '');
  const p = profile();
  if (name) { p.lichess = name; if (!p.name) p.name = name; if (!p.created) p.created = Date.now(); saveProfile(p); }
  A.toast(`Zalogowano na lichess jako ${name}.`);
  renderProfile();
}
async function logoutLichess() {
  const t = lichessToken();
  if (t) fetch('https://lichess.org/api/token', { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } }).catch(() => {});
  A.store.set('lichessOAuth', '');
  liUserCache = null;
  renderProfile();
}

// ---- awatar: wczytaj obrazek i zmniejsz do 128×128
function readAvatar(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = 128, c = document.createElement('canvas');
      c.width = c.height = s;
      const k = Math.max(s / img.width, s / img.height);
      const w = img.width * k, h = img.height * k;
      c.getContext('2d').drawImage(img, (s - w) / 2, (s - h) / 2, w, h);
      resolve(c.toDataURL('image/jpeg', 0.85));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
export function avatarHtml(p = profile(), size = 28) {
  return p.avatar ? `<img class="ava" src="${p.avatar}" width="${size}" height="${size}" alt="">`
    : `<span class="ava ph" style="width:${size}px;height:${size}px">${esc((p.name || '?')[0].toUpperCase())}</span>`;
}
function renderBadge() {
  const p = profile();
  $('profile-badge').innerHTML = p.name ? `${avatarHtml(p, 26)}<span>${esc(p.name)}</span><small class="mono">${p.rating}</small>` : `<span class="ava ph" style="width:26px;height:26px">+</span><span>Utwórz konto</span>`;
}
function renderProfile() {
  const p = profile();
  const li = lichessToken();
  $('pf-ava').innerHTML = avatarHtml(p, 72);
  $('pf-name').value = p.name; $('pf-cc').value = p.chesscom; $('pf-li').value = p.lichess;
  $('pf-stats').innerHTML = `<span class="pill accent">Ranking z silnikiem ${p.rating}</span><span class="pill">Partie ${p.games || 0}</span>`;
  $('pf-lichess').innerHTML = li
    ? `<span class="pill accent">Połączono z lichess${p.lichess ? ': ' + esc(p.lichess) : ''}</span> <button class="btn" id="pf-logout">Wyloguj z lichess</button>`
    : `<button class="btn primary" id="pf-login">Zaloguj przez lichess</button> <span class="muted">Potrzebne do gry na lichess. Hasło wpisujesz tylko na stronie lichess.</span>`;
  $('pf-login') && ($('pf-login').onclick = loginLichess);
  $('pf-logout') && ($('pf-logout').onclick = logoutLichess);
  renderBadge();
}

export function initProfile(api) {
  A = api;
  $('pf-ava-file').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const p = profile(); p.avatar = await readAvatar(f); saveProfile(p); renderProfile();
  };
  $('pf-save').onclick = () => {
    const p = profile();
    p.name = $('pf-name').value.trim(); p.chesscom = $('pf-cc').value.trim(); p.lichess = $('pf-li').value.trim();
    if (!p.created) p.created = Date.now();
    saveProfile(p);
    // nicki trafiają też do importu, drzewka i trenera
    if (p.chesscom) { A.store.set('ccUser', p.chesscom.toLowerCase()); }
    if (p.lichess) { A.store.set('liUser', p.lichess); }
    A.toast('Profil zapisany.'); A.sound.play('Confirmation');
    renderProfile();
  };
  $('pf-del-ava').onclick = () => { const p = profile(); p.avatar = ''; saveProfile(p); renderProfile(); };
  $('profile-badge').onclick = () => { A.showTab('settings'); $('pf-name').scrollIntoView({ block: 'center' }); if (!profile().name) $('pf-name').focus(); };
  renderProfile();
  finishLogin().catch((e) => A.toast('Logowanie: ' + e.message));
}
