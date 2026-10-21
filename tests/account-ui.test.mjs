import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/account.js', import.meta.url), 'utf8');
const password = 'Uma senha de teste longa 42';
const profile = (role = 'client', overrides = {}) => ({
  user_id: 'test-user', role, name: 'Pessoa de teste', establishment_name: role === 'establishment' ? 'Loja de teste' : null,
  created_at: '2026-01-01T00:00:00.000Z', ...overrides,
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function until(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('UI did not settle: ' + description);
}

function mount(handler, { channel = false, basePath = '' } = {}) {
  const mountedHtml = html.replace('name="titoja-base-path" content=""', `name="titoja-base-path" content="${basePath}"`).replace('<base href="/">', `<base href="${basePath}/">`);
  const dom = new JSDOM(mountedHtml, { url: `http://127.0.0.1:4173${basePath}/`, runScripts: 'outside-only' });
  const { window } = dom;
  const calls = [];
  let storageAccesses = 0;
  const messages = [];
  let channelInstance;
  if (channel) window.BroadcastChannel = class {
    constructor(name) { this.name = name; channelInstance = this; }
    postMessage(message) { messages.push(message); }
  };
  for (const method of ['getItem', 'setItem', 'removeItem', 'clear']) {
    window.Storage.prototype[method] = () => { storageAccesses++; throw new Error('Account UI must not use browser storage'); };
  }
  window.fetch = async (path, options) => {
    const request = { path, options, payload: options.body ? JSON.parse(options.body) : undefined };
    calls.push(request);
    return handler(request);
  };
  window.eval(script);
  return { dom, window, document: window.document, calls, messages,
    sessionEvent: () => channelInstance.onmessage({ data: { type: 'changed' } }),
    storageAccesses: () => storageAccesses };
}

function fill(ui, fields) {
  const form = ui.document.getElementById('auth-form');
  for (const [name, value] of Object.entries(fields)) form.elements.namedItem(name).value = value;
  return form;
}
function submit(ui, form) { form.dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true })); }

test('a mounted account keeps login, assets and account/application/demo navigation under its configured base', async t => {
  const saved = profile();
  const ui = mount(request => {
    if (request.path === '/titoja/api/account') return json({}, 401);
    if (request.path === '/titoja/api/auth/login') return json({ profile: saved });
    if (request.path === '/titoja/api/dashboard?role=client') return json({ profile: saved });
    if (request.path === '/titoja/api/auth/logout') return json({ ok: true });
    assert.fail('A mounted account escaped its base: ' + request.path);
  }, { basePath: '/titoja' });
  t.after(() => ui.dom.window.close());
  await until(() => ui.document.getElementById('auth-form'), 'mounted login');
  assert.equal(ui.document.querySelector('link[rel=stylesheet]').href, 'http://127.0.0.1:4173/titoja/account.css');
  assert.equal(ui.document.querySelector('script[src]').src, 'http://127.0.0.1:4173/titoja/account.js');
  assert.equal(ui.document.querySelector('.brand').href, 'http://127.0.0.1:4173/titoja/');
  assert.equal(ui.document.querySelector('.hero-art img').src, 'http://127.0.0.1:4173/titoja/assets/beer-3d.png');
  submit(ui, fill(ui, { email: 'pessoa@example.test', password }));
  await until(() => ui.document.querySelector('.badge'), 'mounted dashboard');
  assert.equal(ui.document.querySelector('a.primary').href, 'http://127.0.0.1:4173/titoja/app/');
  assert.equal(ui.document.querySelector('a.secondary').href, 'http://127.0.0.1:4173/titoja/demo/');
  ui.document.getElementById('signout').click();
  await until(() => ui.document.getElementById('auth-form'), 'mounted logout');
  assert.ok(ui.calls.every(call => call.path.startsWith('/titoja/api/')));
});

test('guest offers email/password login, honest limits and no platform or stored identity', async t => {
  const ui = mount(() => json({ error: 'Entre na sua conta' }, 401));
  t.after(() => ui.dom.window.close());
  await until(() => ui.document.getElementById('auth-form'), 'guest form');
  const input = ui.document.querySelector('[name=password]');
  assert.equal(input.type, 'password');
  assert.equal(input.autocomplete, 'current-password');
  assert.equal(input.minLength, 15);
  assert.equal(input.maxLength, 128);
  assert.equal(ui.document.querySelector('[name=email]').autocomplete, 'username');
  assert.match(ui.document.body.textContent, /Recuperação de senha indisponível/);
  assert.match(ui.document.body.textContent, /pagamento é simulado, sem cobrança/i);
  assert.equal(ui.document.querySelector('[href*=chatgpt]'), null);
  assert.equal(ui.document.getElementById('signout').tagName, 'BUTTON');
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].options.credentials, 'same-origin');
  assert.equal(ui.storageAccesses(), 0);
});

for (const role of ['client', 'courier', 'driver', 'establishment']) {
  test('registration submits only account fields for ' + role + ' and opens the saved profile', async t => {
    const user = profile(role);
    const ui = mount(request => {
      if (request.path === '/api/account') return json({ error: 'Entre na sua conta' }, 401);
      if (request.path === '/api/auth/register') return json({ profile: user, identity: { name: user.name, email: 'pessoa@example.test' } }, 201);
      if (request.path === '/api/dashboard?role=' + role) return json({ profile: user });
      assert.fail('Unexpected request ' + request.path);
    });
    t.after(() => ui.dom.window.close());
    await until(() => ui.document.getElementById('auth-form'), 'guest form');
    ui.document.querySelector('[data-auth-mode=register]').click();
    assert.equal(ui.document.querySelector('[name=password]').autocomplete, 'new-password');
    assert.equal(ui.document.querySelectorAll('input[name=role]').length, 4);
    assert.equal(ui.document.querySelector('input[value=admin]'), null);
    const selected = ui.document.querySelector(`input[name=role][value=${role}]`);
    selected.checked = true;
    selected.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    const fields = { name: user.name, email: 'pessoa@example.test', password };
    if (role === 'establishment') fields.establishmentName = user.establishment_name;
    const form = fill(ui, fields);
    assert.equal(form.elements.namedItem('establishmentName').required, role === 'establishment');
    submit(ui, form);
    assert.equal(form.elements.namedItem('password').value, '');
    await until(() => ui.document.querySelector('.badge'), 'registered dashboard');
    const request = ui.calls.find(call => call.path === '/api/auth/register');
    assert.deepEqual(request.payload, { email: fields.email, password, name: fields.name, role, ...(role === 'establishment' ? { establishmentName: fields.establishmentName } : {}) });
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.equal(ui.document.getElementById('signout').hidden, false);
    assert.ok(ui.document.querySelector('a[href="/app/"]'));
    assert.equal(ui.storageAccesses(), 0);
    assert.equal(ui.document.body.textContent.includes(password), false);
  });
}

test('login blocks repeated submits, clears password and shows a generic invalid-login error', async t => {
  let finishLogin;
  const pendingLogin = new Promise(resolve => { finishLogin = resolve; });
  const ui = mount(request => request.path === '/api/account' ? json({}, 401) : pendingLogin);
  t.after(() => ui.dom.window.close());
  await until(() => ui.document.getElementById('auth-form'), 'guest form');
  const form = fill(ui, { email: 'pessoa@example.test', password });
  submit(ui, form);
  submit(ui, form);
  assert.equal(ui.calls.filter(call => call.path === '/api/auth/login').length, 1);
  assert.equal(ui.document.getElementById('auth-submit').disabled, true);
  assert.equal(ui.document.querySelector('[data-auth-mode=register]').disabled, true);
  assert.equal(form.elements.namedItem('password').value, '');
  finishLogin(json({ error: '<img src=x onerror=alert(1)>' }, 401));
  await until(() => !ui.document.getElementById('auth-submit').disabled, 'failed login');
  assert.equal(ui.document.getElementById('auth-error').textContent, 'E-mail ou senha inválidos. Tente novamente.');
  assert.equal(ui.document.querySelector('[onerror]'), null);
  assert.equal(ui.storageAccesses(), 0);
});

test('login and logout use server session endpoints without copying session data into storage', async t => {
  const user = profile('courier');
  const ui = mount(request => {
    if (request.path === '/api/account') return json({}, 401);
    if (request.path === '/api/auth/login') return json({ profile: user });
    if (request.path === '/api/dashboard?role=courier') return json({ profile: user });
    if (request.path === '/api/auth/logout') return json({ ok: true });
    assert.fail('Unexpected request ' + request.path);
  });
  t.after(() => ui.dom.window.close());
  await until(() => ui.document.getElementById('auth-form'), 'guest form');
  submit(ui, fill(ui, { email: 'pessoa@example.test', password }));
  await until(() => ui.document.querySelector('.badge'), 'logged-in dashboard');
  ui.document.getElementById('signout').click();
  await until(() => ui.document.getElementById('auth-form'), 'logged-out form');
  const logout = ui.calls.find(call => call.path === '/api/auth/logout');
  assert.equal(logout.options.method, 'POST');
  assert.deepEqual(logout.payload, {});
  assert.equal(logout.options.credentials, 'same-origin');
  assert.equal(ui.document.getElementById('signout').hidden, true);
  assert.equal(ui.storageAccesses(), 0);
});

test('profile and backend error text are escaped; failed logout keeps the session view honest', async t => {
  const user = profile('establishment', { name: '<img src=x onerror=alert(1)>', establishment_name: '<script>alert(1)</script>' });
  const ui = mount(request => {
    if (request.path === '/api/account' || request.path.startsWith('/api/dashboard')) return json({ profile: user });
    if (request.path === '/api/auth/logout') return json({ error: '<b>Falha de teste</b>' }, 500);
    assert.fail('Unexpected request ' + request.path);
  });
  t.after(() => ui.dom.window.close());
  await until(() => ui.document.querySelector('.badge'), 'saved dashboard');
  assert.equal(ui.document.querySelector('[onerror]'), null);
  assert.equal(ui.document.querySelector('#account script'), null);
  assert.match(ui.document.querySelector('.profile-heading').textContent, /<script>/);
  ui.document.getElementById('signout').click();
  await until(() => ui.document.getElementById('account-error').textContent.length > 0, 'logout error');
  assert.equal(ui.document.getElementById('signout').hidden, false);
  assert.equal(ui.document.querySelector('#account-error b'), null);
  assert.match(ui.document.getElementById('account-error').textContent, /<b>Falha de teste<\/b>/);
  assert.equal(ui.storageAccesses(), 0);
});

test('a successful login still offers logout when the dashboard request fails', async t => {
  const user = profile();
  const ui = mount(request => {
    if (request.path === '/api/account') return json({}, 401);
    if (request.path === '/api/auth/login') return json({ profile: user });
    if (request.path.startsWith('/api/dashboard')) return json({ error: 'Área temporariamente indisponível' }, 503);
    if (request.path === '/api/auth/logout') return json({ ok: true });
    assert.fail('Unexpected request ' + request.path);
  });
  t.after(() => ui.dom.window.close());
  await until(() => ui.document.getElementById('auth-form'), 'guest form');
  submit(ui, fill(ui, { email: 'pessoa@example.test', password }));
  await until(() => ui.document.getElementById('auth-error').textContent.length > 0, 'dashboard error');
  assert.equal(ui.document.getElementById('signout').hidden, false);
  ui.document.getElementById('signout').click();
  await until(() => ui.document.getElementById('signout').hidden, 'logout after dashboard error');
  assert.ok(ui.calls.some(call => call.path === '/api/auth/logout'));
});

test('back-forward cache rechecks the server and removes stale private profile immediately', async t => {
  const user = profile();
  let signedIn = true;
  const ui = mount(request => {
    if (request.path === '/api/account') return signedIn ? json({ profile: user }) : json({}, 401);
    if (request.path.startsWith('/api/dashboard')) return json({ profile: user });
    assert.fail('Unexpected request ' + request.path);
  });
  t.after(() => ui.dom.window.close());
  await until(() => ui.document.querySelector('.badge'), 'saved dashboard');
  signedIn = false;
  const event = new ui.window.Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: true });
  ui.window.dispatchEvent(event);
  assert.equal(ui.document.body.textContent.includes(user.name), false);
  await until(() => ui.document.getElementById('auth-form'), 'revalidated guest');
  assert.equal(ui.calls.filter(call => call.path === '/api/account').length, 2);
});

test('an older in-flight account response cannot restore a private dashboard after logout', async t => {
  const user = profile();
  let accountRequests = 0;
  let finishOldRequest;
  const oldRequest = new Promise(resolve => { finishOldRequest = resolve; });
  const ui = mount(request => {
    if (request.path === '/api/account') return ++accountRequests === 1 ? json({ profile: user }) : oldRequest;
    if (request.path.startsWith('/api/dashboard')) return json({ profile: user });
    if (request.path === '/api/auth/logout') return json({ ok: true });
    assert.fail('Unexpected request ' + request.path);
  });
  t.after(() => ui.dom.window.close());
  await until(() => ui.document.querySelector('.badge'), 'saved dashboard');
  const event = new ui.window.Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: true });
  ui.window.dispatchEvent(event);
  assert.equal(ui.document.getElementById('signout').hidden, true);
  ui.document.getElementById('signout').click();
  await until(() => ui.document.getElementById('auth-form'), 'logout while account revalidation pending');
  finishOldRequest(json({ profile: user }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(ui.document.getElementById('auth-form'));
  assert.equal(ui.document.querySelector('.badge'), null);
  assert.equal(ui.document.body.textContent.includes(user.name), false);
  assert.equal(ui.calls.find(call => call.path === '/api/auth/logout').options.headers['X-Titoja-User'], user.user_id);
});

test('another tab changing the session clears the old profile before loading the new account', async t => {
  let user = profile('client', { user_id: 'first-user', name: 'Primeira Pessoa' });
  let finishAccount;
  let delayed = false;
  const ui = mount(request => {
    if (request.path === '/api/account') return delayed ? new Promise(resolve => { finishAccount = resolve; }) : json({ profile: user });
    if (request.path.startsWith('/api/dashboard')) return json({ profile: user });
    assert.fail('Unexpected request ' + request.path);
  }, { channel: true });
  t.after(() => ui.window.close());
  await until(() => ui.document.querySelector('.badge'), 'first profile');
  delayed = true;
  user = profile('establishment', { user_id: 'second-user', name: 'Segunda Pessoa', establishment_name: 'Outra Loja' });
  ui.sessionEvent();
  assert.equal(ui.document.body.textContent.includes('Primeira'), false);
  assert.equal(ui.document.querySelector('.badge'), null);
  assert.equal(ui.document.getElementById('signout').hidden, true);
  finishAccount(json({ profile: user }));
  await until(() => ui.document.querySelector('.badge'), 'second profile');
  assert.match(ui.document.body.textContent, /Segunda/);
  assert.match(ui.document.body.textContent, /Outra Loja/);
  assert.equal(ui.document.body.textContent.includes('Primeira'), false);
});

test('logout broadcasts only a session-change signal and binds revocation to the displayed user', async t => {
  const user = profile();
  const ui = mount(request => {
    if (request.path === '/api/account' || request.path.startsWith('/api/dashboard')) return json({ profile: user });
    if (request.path === '/api/auth/logout') return json({ ok: true });
    assert.fail('Unexpected request ' + request.path);
  }, { channel: true });
  t.after(() => ui.window.close());
  await until(() => ui.document.querySelector('.badge'), 'profile');
  ui.document.getElementById('signout').click();
  await until(() => ui.document.getElementById('auth-form'), 'logout');
  assert.equal(ui.calls.find(call => call.path === '/api/auth/logout').options.headers['X-Titoja-User'], user.user_id);
  assert.equal(JSON.stringify(ui.messages), '[{"type":"changed"}]');
  assert.equal(ui.storageAccesses(), 0);
});

test('identity changing between account and dashboard never renders the previous account', async t => {
  const oldUser = profile('client', { user_id: 'old', name: 'Anterior Pessoa' });
  const newUser = profile('client', { user_id: 'new', name: 'Atual Pessoa' });
  let reads = 0;
  const ui = mount(request => {
    if (request.path === '/api/account') return json({ profile: ++reads === 1 ? oldUser : newUser });
    if (request.path.startsWith('/api/dashboard')) return json({ profile: newUser });
    assert.fail('Unexpected request ' + request.path);
  });
  t.after(() => ui.window.close());
  await until(() => ui.document.querySelector('.badge'), 'new account');
  assert.equal(reads, 2);
  assert.equal(ui.document.body.textContent.includes('Anterior'), false);
  assert.match(ui.document.body.textContent, /Atual/);
});

test('returning focus preserves an unfinished guest form', async t => {
  const ui = mount(() => json({}, 401));
  t.after(() => ui.window.close());
  await until(() => ui.document.getElementById('auth-form'), 'guest');
  const form = fill(ui, { email: 'draft@example.test', password });
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  assert.equal(ui.document.getElementById('auth-form'), form);
  assert.equal(form.elements.namedItem('email').value, 'draft@example.test');
  assert.equal(ui.calls.length, 1);
});

test('a delayed logout response rechecks the cookie instead of overwriting a newer account view', async t => {
  let user = profile('client', { user_id: 'previous', name: 'Anterior Pessoa' });
  let finishLogout;
  const ui = mount(request => {
    if (request.path === '/api/account' || request.path.startsWith('/api/dashboard')) return json({ profile: user });
    if (request.path === '/api/auth/logout') return new Promise(resolve => { finishLogout = resolve; });
    assert.fail('Unexpected request ' + request.path);
  }, { channel: true });
  t.after(() => ui.window.close());
  await until(() => ui.document.querySelector('.badge'), 'previous account');
  ui.document.getElementById('signout').click();
  await until(() => finishLogout, 'pending logout');
  user = profile('courier', { user_id: 'current', name: 'Atual Pessoa' });
  ui.sessionEvent();
  await until(() => ui.document.body.textContent.includes('Atual Pessoa'), 'current account');
  finishLogout(json({ ok: true }));
  await until(() => ui.calls.filter(call => call.path === '/api/account').length === 3 && ui.document.querySelector('.badge'), 'cookie recheck');
  assert.match(ui.document.body.textContent, /Atual Pessoa/);
  assert.equal(ui.document.getElementById('auth-form'), null);
  assert.equal(ui.document.getElementById('signout').disabled, false);
});
