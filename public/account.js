'use strict';

const root = document.getElementById('account');
const signout = document.getElementById('signout');
const labels = { client: 'Cliente', courier: 'Entregador', driver: 'Motorista', establishment: 'Estabelecimento' };
const descriptions = {
  client: 'Solicite serviços e acompanhe seus pedidos.',
  courier: 'Tenha seu cadastro de entregador separado e seguro.',
  driver: 'Receba solicitações de mototáxi e carro.',
  establishment: 'Cadastre sua loja e tenha sua própria área.',
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
let busy = false;
let viewVersion = 0;
let currentUserId = null;
let logoutUserId = null;
let sessionChannel;
try { sessionChannel = new BroadcastChannel('titoja-session'); } catch {}
function sessionChanged() { sessionChannel?.postMessage({ type: 'changed' }); }

async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options }); }
  catch { throw new Error('Não foi possível conectar. Confira sua conexão e tente novamente.'); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Não foi possível carregar. Tente novamente.'); }
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : 'Não foi possível concluir.');
    error.status = response.status;
    throw error;
  }
  const userId = response.headers.get('X-Titoja-User');
  if (userId && data.profile && userId !== data.profile.user_id) {
    throw new Error('A conta mudou. Atualize a página antes de continuar.');
  }
  return data;
}
function mutation(path, payload) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json',
    ...(path === '/api/auth/logout' && logoutUserId ? { 'X-Titoja-User': logoutUserId } : {}) }, body: JSON.stringify(payload) });
}
function setBusy(value) {
  busy = value;
  signout.disabled = value;
  root.querySelectorAll('button').forEach(button => { button.disabled = value; });
}

function guest(mode = 'login') {
  viewVersion++;
  currentUserId = null;
  logoutUserId = null;
  signout.hidden = true;
  const registering = mode === 'register';
  root.innerHTML = `
    <section class="hero">
      <div><span class="eyebrow">Seu dia pede TitoJá</span><h1>Peça, entregue.<br>Faça acontecer.</h1>
        <p>Comida e cerveja perto de você. Um cadastro para cada jeito de participar.</p>
        <p><small>Cadastros, pedidos, aceite e etapas são compartilhados entre as contas participantes. Somente o pagamento é simulado, sem cobrança.</small></p>
      </div>
      <div class="hero-art"><img src="/assets/beer-3d.png" alt="Cervejas geladas no TitoJá"></div>
    </section>
    <section class="card auth-card" aria-labelledby="auth-title">
      <nav class="auth-tabs" aria-label="Acesso à conta">
        <button type="button" class="secondary" data-auth-mode="login" aria-pressed="${!registering}">Entrar</button>
        <button type="button" class="secondary" data-auth-mode="register" aria-pressed="${registering}">Criar conta</button>
      </nav>
      <h2 id="auth-title">${registering ? 'Crie seu perfil no TitoJá' : 'Entre na sua conta'}</h2>
      <form id="auth-form">
        ${registering ? `<fieldset class="role-options"><legend>Qual é o seu perfil?</legend><div class="roles">${Object.entries(labels).map(([role, label]) => `
          <label class="role"><input type="radio" name="role" value="${role}" ${role === 'client' ? 'checked' : ''}><strong>${label}</strong><p>${descriptions[role]}</p></label>`).join('')}</div></fieldset>
          <label class="field"><span>Seu nome</span><input name="name" autocomplete="name" minlength="2" maxlength="80" required></label>
          <label class="field" id="establishment-field" hidden><span>Nome do estabelecimento</span><input name="establishmentName" autocomplete="organization" minlength="2" maxlength="100" disabled></label>` : ''}
        <label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="username" maxlength="254" autocapitalize="none" spellcheck="false" required></label>
        <label class="field"><span>Senha</span><input name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" minlength="15" maxlength="128" aria-describedby="password-help" required></label>
        <p id="password-help"><small>Use de 15 a 128 caracteres. Escolha uma senha longa e exclusiva.</small></p>
        ${registering ? '<div class="note">O perfil fica vinculado à sua conta e não pode ser trocado aqui. Cada pessoa acessa somente seu próprio cadastro. Não envie documentos ou dados de pagamento. O e-mail ainda não passa por confirmação de titularidade.</div>' : ''}
        <p class="error" id="auth-error" role="alert"></p>
        <button class="primary" id="auth-submit" type="submit">${registering ? 'Concluir cadastro' : 'Entrar'}</button>
      </form>
      <p class="recovery-note"><small>Recuperação de senha indisponível nesta versão: o serviço de e-mail ainda não está configurado. Nenhum e-mail de recuperação é enviado.</small></p>
    </section>`;
  root.querySelectorAll('[data-auth-mode]').forEach(button => button.addEventListener('click', () => {
    if (!busy) {
      const mode = button.dataset.authMode;
      guest(mode);
      root.querySelector(`[data-auth-mode="${mode}"]`).focus();
    }
  }));
  root.querySelectorAll('input[name="role"]').forEach(input => input.addEventListener('change', () => {
    const establishment = root.querySelector('input[name="role"]:checked').value === 'establishment';
    const field = document.getElementById('establishment-field');
    const name = field.querySelector('input');
    field.hidden = !establishment;
    name.required = establishment;
    name.disabled = !establishment;
    if (!establishment) name.value = '';
  }));
  document.getElementById('auth-form').addEventListener('submit', event => authenticate(event, mode));
}

async function authenticate(event, mode) {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const payload = { email: data.get('email'), password: data.get('password') };
  if (mode === 'register') {
    payload.name = data.get('name');
    payload.role = data.get('role');
    if (payload.role === 'establishment') payload.establishmentName = data.get('establishmentName');
  }
  form.elements.namedItem('password').value = '';
  const errorElement = document.getElementById('auth-error');
  errorElement.textContent = '';
  const version = ++viewVersion;
  setBusy(true);
  try {
    const result = await mutation(`/api/auth/${mode}`, payload);
    sessionChanged();
    if (version === viewVersion) {
      logoutUserId = result.profile?.user_id ?? null;
      signout.hidden = false;
      await dashboard(result.profile, version);
    } else await load();
  } catch (error) {
    if (version === viewVersion) {
      errorElement.textContent = error.status === 401 && mode === 'login'
        ? 'E-mail ou senha inválidos. Tente novamente.' : error.message;
    }
  } finally {
    payload.password = '';
    form.elements.namedItem('password').value = '';
    setBusy(false);
  }
}

function validateProfile(profile) {
  if (!profile || !Object.hasOwn(labels, profile.role) || typeof profile.name !== 'string') {
    throw new Error('Não foi possível carregar seu perfil. Tente novamente.');
  }
  return profile;
}
async function dashboard(profile, version) {
  validateProfile(profile);
  const expectedUserId = profile.user_id;
  const result = await api('/api/dashboard?role=' + encodeURIComponent(profile.role));
  if (version !== viewVersion) return;
  profile = validateProfile(result.profile);
  if (profile.user_id !== expectedUserId) { await load(); return; }
  currentUserId = profile.user_id;
  logoutUserId = profile.user_id;
  signout.hidden = false;
  const title = profile.role === 'client' ? 'O que vai ser hoje?' : profile.role === 'courier' || profile.role === 'driver' ? 'Sua área de serviços' : 'Sua loja no TitoJá';
  root.innerHTML = `<span class="eyebrow">${labels[profile.role]}</span><h1>Olá, ${escape(profile.name.split(' ')[0])}!</h1><p>${title}</p>
    <p class="error" id="account-error" role="alert"></p>
    <div class="grid"><section class="card"><span class="badge">Cadastro salvo no banco</span>
      <h2 class="profile-heading">${profile.role === 'establishment' ? escape(profile.establishment_name) : labels[profile.role]}</h2>
      <p>${escape(profile.name)}</p><p>Seu perfil está vinculado à sua conta TitoJá. Ao sair e entrar novamente com o mesmo e-mail e senha, seu cadastro continua aqui.</p>
      <small>Perfil: ${labels[profile.role]} · sem acesso a outras contas</small></section>
      <section class="card"><h2>${profile.role === 'client' ? 'Meus pedidos' : profile.role === 'courier' || profile.role === 'driver' ? 'Meus serviços' : 'Pedidos do estabelecimento'}</h2>
      <p>Consulte suas solicitações, ofertas e etapas na área do aplicativo. Cada perfil acessa somente os serviços permitidos para sua conta.</p>
      <a class="primary" href="/app/">Abrir aplicativo</a></section></div>
    <div class="services"><div class="service"><span aria-hidden="true">🍔</span>Comida</div><div class="service"><span aria-hidden="true">🍺</span>Cerveja</div></div>
    <div class="note">Os pedidos são registrados e compartilhados entre as contas participantes. Somente o pagamento é simulado: não há cobrança. A demonstração separada não altera sua conta nem seus pedidos.</div>
    <a class="secondary" href="/demo/">Explorar a demonstração com dados fictícios</a>`;
}

async function load() {
  const version = ++viewVersion;
  currentUserId = null;
  setBusy(false);
  signout.hidden = true;
  root.innerHTML = '<div class="card"><h1>Carregando sua conta.</h1></div>';
  try {
    const data = await api('/api/account');
    if (version === viewVersion) {
      logoutUserId = data.profile?.user_id ?? null;
      signout.hidden = false;
      await dashboard(data.profile, version);
    }
  } catch (error) {
    if (version !== viewVersion) return;
    if (error.status === 401) guest();
    else {
      root.innerHTML = '<section class="card"><h1>Não foi possível carregar</h1><p class="error" id="account-error" role="alert"></p><button class="primary" id="retry" type="button">Tentar novamente</button></section>';
      document.getElementById('account-error').textContent = error.message;
      document.getElementById('retry').addEventListener('click', load);
    }
  }
}
signout.addEventListener('click', async () => {
  if (busy) return;
  const version = ++viewVersion;
  setBusy(true);
  try {
    await mutation('/api/auth/logout', {});
    sessionChanged();
    if (version === viewVersion) { setBusy(false); guest(); }
    else await load();
  }
  catch (error) {
    if (version !== viewVersion) return;
    let errorElement = document.getElementById('account-error') || document.getElementById('auth-error');
    if (!errorElement) {
      errorElement = document.createElement('p');
      errorElement.className = 'error';
      errorElement.setAttribute('role', 'alert');
      root.append(errorElement);
    }
    errorElement.textContent = 'Não foi possível sair. ' + error.message;
  } finally { if (version === viewVersion) setBusy(false); }
});
window.addEventListener('pageshow', event => { if (event.persisted) load(); });
window.addEventListener('focus', () => { if (!busy && currentUserId) void load(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !busy && currentUserId) void load();
});
if (sessionChannel) sessionChannel.onmessage = event => {
  if (event.data?.type !== 'changed') return;
  // Invalidate pending auth/dashboard responses before checking the shared cookie.
  busy = false;
  setBusy(false);
  signout.hidden = true;
  void load();
};
// Covers browsers without BroadcastChannel and expired/revoked sessions.
let checkingSession = false;
setInterval(async () => {
  if (!currentUserId || busy || checkingSession || document.visibilityState === 'hidden') return;
  checkingSession = true;
  const version = viewVersion;
  const expectedUserId = currentUserId;
  try {
    const data = await api('/api/account');
    if (version === viewVersion && data.profile?.user_id !== expectedUserId) await load();
  } catch (error) {
    if (version === viewVersion) {
      if (error.status === 401) guest();
      else { signout.hidden = true; await load(); }
    }
  } finally { checkingSession = false; }
}, 5000);
load();
