import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { createApp } from '../dist/server/app.js';
import { supportedSqliteVersion } from '../dist/server/database.js';

const origin = 'http://127.0.0.1:4173';
const fixturePassword = () => 'test-only-passphrase-' + randomUUID();
const registration = (role, password, email = role + '@fixture.test') => ({
  email, password, role, name: 'Fixture ' + role,
  ...(role === 'establishment' ? { establishmentName: 'Fixture Store' } : {}),
});

async function fixture(t, overrides = {}) {
  const temporaryRoot = resolve(tmpdir());
  const folder = mkdtempSync(join(temporaryRoot, 'titoja-api-'));
  const databasePath = join(folder, 'accounts.sqlite');
  let app;
  let base;
  async function start() {
    app = createApp({ databasePath, origin, authRateLimit: { windowMs: 900000, maxAttempts: 1000 }, ...overrides });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = 'http://127.0.0.1:' + app.server.address().port;
  }
  await start();
  t.after(async () => {
    await app.close();
    // Only remove the exact directory created by mkdtemp under the temporary root.
    if (!resolve(folder).startsWith(temporaryRoot + sep) || !folder.includes('titoja-api-')) throw Error('Unsafe temporary cleanup target');
    rmSync(folder, { recursive: true, force: true });
  });
  return {
    get database() { return app.database; },
    async restart() { await app.close(); await start(); },
    async request(path, { method = 'GET', body, rawBody, cookie, requestOrigin = overrides.origin ?? origin, headers = {}, contentType = 'application/json' } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(requestOrigin === null ? {} : { Origin: requestOrigin }),
          ...((body !== undefined || rawBody !== undefined) && contentType !== null ? { 'Content-Type': contentType } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      return {
        response, status: response.status, text,
        json: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null,
        cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null,
      };
    },
  };
}

test('real HTTP signup persists four fixed roles with isolated accounts', async t => {
  const app = await fixture(t);
  const password = fixturePassword();
  const accounts = [];
  for (const role of ['client', 'courier', 'establishment', 'driver']) {
    const result = await app.request('/api/auth/register', { method: 'POST', body: registration(role, password) });
    assert.equal(result.status, 201);
    assert.equal(result.json.profile.role, role);
    assert.equal(result.json.identity.email, role + '@fixture.test');
    assert.ok(result.cookie, 'A session cookie is issued');
    assert.deepEqual(Object.keys(result.json).sort(), ['identity', 'profile']);
    accounts.push(result);
  }
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_users').get().n, 4);
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_profiles').get().n, 4);
  for (const account of accounts) {
    const current = await app.request('/api/account', { cookie: account.cookie });
    assert.equal(current.json.profile.user_id, account.json.profile.user_id);
    for (const role of ['client', 'courier', 'establishment', 'driver']) {
      const dashboard = await app.request('/api/dashboard?role=' + role, { cookie: account.cookie });
      assert.equal(dashboard.status, role === account.json.profile.role ? 200 : 403);
      if (dashboard.status === 200) assert.equal(dashboard.json.profile.user_id, account.json.profile.user_id);
    }
  }
  const hashes = app.database.prepare('SELECT password_hash FROM titoja_users').all();
  assert.equal(new Set(hashes.map(row => row.password_hash)).size, 4, 'Identical passwords receive independent salts');
  assert.ok(hashes.every(row => row.password_hash.startsWith('scrypt$32768$8$3$') && !row.password_hash.includes(password)));
});

test('normalizes email and rejects duplicate registration without partial records', async t => {
  const app = await fixture(t);
  const password = fixturePassword();
  const first = await app.request('/api/auth/register', { method: 'POST', body: registration('client', password, '  Fixture@Example.test  ') });
  assert.equal(first.status, 201);
  assert.equal(first.json.identity.email, 'fixture@example.test');
  const second = await app.request('/api/auth/register', { method: 'POST', body: registration('courier', password, 'FIXTURE@example.test') });
  assert.equal(second.status, 409);
  for (const table of ['titoja_users', 'titoja_profiles', 'titoja_sessions']) {
    assert.equal(app.database.prepare('SELECT count(*) AS n FROM ' + table).get().n, 1);
  }
});

test('login rotates existing sessions; logout revokes access on the server', async t => {
  const app = await fixture(t);
  const password = fixturePassword();
  const registered = await app.request('/api/auth/register', { method: 'POST', body: registration('client', password) });
  const loggedIn = await app.request('/api/auth/login', {
    method: 'POST', cookie: registered.cookie, body: { email: 'client@fixture.test', password },
  });
  assert.equal(loggedIn.status, 200);
  assert.ok(loggedIn.cookie !== registered.cookie, 'Login rotates the presented session');
  assert.equal((await app.request('/api/account', { cookie: registered.cookie })).status, 401);
  assert.equal((await app.request('/api/account', { cookie: loggedIn.cookie })).status, 200);
  const logout = await app.request('/api/auth/logout', { method: 'POST', cookie: loggedIn.cookie, body: {} });
  assert.equal(logout.status, 200);
  assert.ok(logout.response.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal((await app.request('/api/account', { cookie: loggedIn.cookie })).status, 401);
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_sessions').get().n, 0);
});

test('credentials fail generically and do not leak secrets in response payloads', async t => {
  const app = await fixture(t);
  const password = fixturePassword();
  await app.request('/api/auth/register', { method: 'POST', body: registration('client', password) });
  const wrong = await app.request('/api/auth/login', { method: 'POST', body: { email: 'client@fixture.test', password: fixturePassword() } });
  const unknown = await app.request('/api/auth/login', { method: 'POST', body: { email: 'missing@fixture.test', password: fixturePassword() } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.json, unknown.json);
  assert.equal(wrong.cookie, null);
  assert.equal(unknown.cookie, null);
  assert.ok(!wrong.text.includes(password) && !wrong.text.includes('scrypt$'));
});

test('server ignores platform identity/role headers and rejects escalation payloads', async t => {
  const app = await fixture(t);
  const password = fixturePassword();
  assert.equal((await app.request('/api/account', { headers: { 'oai-authenticated-user-id': 'attacker', 'oai-authenticated-user-email': 'admin@fixture.test', 'X-User-Role': 'admin' } })).status, 401);
  for (const extra of [{ role: 'admin' }, { isAdmin: true }, { userId: 'victim' }, { user_id: 'victim' }, { permissions: ['admin'] }]) {
    const attempted = await app.request('/api/auth/register', { method: 'POST', body: { ...registration('client', password), ...extra } });
    assert.equal(attempted.status, 400);
  }
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_users').get().n, 0);
  const registered = await app.request('/api/auth/register', { method: 'POST', body: registration('client', password) });
  const change = await app.request('/api/account', { method: 'POST', cookie: registered.cookie, body: { role: 'driver', name: 'Changed' } });
  assert.equal(change.status, 405);
  const current = await app.request('/api/account', { cookie: registered.cookie, headers: { 'X-User-Role': 'establishment' } });
  assert.equal(current.json.profile.role, 'client');
  assert.equal((await app.request('/api/dashboard?role=admin', { cookie: registered.cookie })).status, 400);
  assert.equal((await app.request('/api/admin/users', { cookie: registered.cookie })).status, 404);
});

test('CSRF, content type, malformed JSON, excessive bodies and invalid fields are rejected', async t => {
  const app = await fixture(t);
  const payload = registration('client', fixturePassword());
  const send = options => app.request('/api/auth/register', { method: 'POST', body: payload, ...options });
  assert.equal((await send({ requestOrigin: 'https://attacker.test' })).status, 403);
  assert.equal((await send({ requestOrigin: null })).status, 403);
  assert.equal((await send({ headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await send({ contentType: 'text/plain' })).status, 415);
  assert.equal((await send({ rawBody: '{invalid' })).status, 400);
  assert.equal((await send({ rawBody: '[]' })).status, 400);
  assert.equal((await send({ rawBody: JSON.stringify({ ignored: 'x'.repeat(5000) }) })).status, 413);
  for (const changed of [
    { email: 'invalid' }, { email: 'a..b@fixture.test' }, { password: 'short' }, { password: 'x'.repeat(129) },
    { name: '<script>' }, { name: 'x' }, { role: 'establishment', establishmentName: '' },
    { establishmentName: 'Not allowed for client' },
  ]) assert.equal((await send({ body: { ...payload, ...changed } })).status, 400);
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_users').get().n, 0);
});

test('SQL-looking profile values are stored as text and cannot change other accounts', async t => {
  const app = await fixture(t);
  const payload = { ...registration('client', fixturePassword()), name: "Fixture'); DROP TABLE titoja_users;--" };
  const registered = await app.request('/api/auth/register', { method: 'POST', body: payload });
  assert.equal(registered.status, 201);
  assert.equal((await app.request('/api/account', { cookie: registered.cookie })).json.profile.name, payload.name);
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_users').get().n, 1);
  const forged = await app.request('/api/auth/login', { method: 'POST', body: { email: "' OR 1=1--@fixture.test", password: fixturePassword() } });
  assert.ok([400, 401].includes(forged.status));
  assert.equal(forged.cookie, null);
});

test('sessions expire absolutely and accounts remain after reopening the database', async t => {
  let clock = Date.now();
  const app = await fixture(t, { sessionTtlMs: 1000, now: () => clock });
  const password = fixturePassword();
  const created = await app.request('/api/auth/register', { method: 'POST', body: registration('courier', password) });
  await app.restart();
  assert.equal((await app.request('/api/account', { cookie: created.cookie })).status, 200);
  clock += 1001;
  assert.equal((await app.request('/api/account', { cookie: created.cookie })).status, 401);
  const signedIn = await app.request('/api/auth/login', { method: 'POST', body: { email: 'courier@fixture.test', password } });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.json.profile.user_id, created.json.profile.user_id);
  assert.equal(signedIn.json.profile.role, 'courier');
  assert.ok(app.database.prepare('SELECT count(*) AS n FROM schema_migrations').get().n >= 1);
});

test('Secure host cookie flags and hashed session storage exclude bearer tokens from JSON/database', async t => {
  const app = await fixture(t, { origin: 'https://titoja.fixture.test' });
  const result = await app.request('/api/auth/register', { method: 'POST', body: registration('client', fixturePassword()) });
  assert.equal(result.status, 201);
  const cookieHeader = result.response.headers.get('set-cookie');
  assert.ok(cookieHeader.startsWith('__Host-titoja_session='));
  for (const flag of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure', 'Max-Age=604800']) assert.ok(cookieHeader.includes(flag), 'Cookie contains ' + flag);
  assert.ok(!cookieHeader.includes('Domain='));
  const bearer = result.cookie.split('=')[1];
  const stored = app.database.prepare('SELECT token_hash FROM titoja_sessions').get().token_hash;
  assert.equal(stored, createHash('sha256').update(bearer).digest('hex'));
  assert.ok(!result.text.includes(bearer), 'Bearer token never appears in JSON');
  assert.notEqual(stored, bearer);
});

test('foreign keys and atomic registration prevent orphaned or partially created records', async t => {
  const app = await fixture(t);
  assert.equal(app.database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => app.database.prepare('INSERT INTO titoja_sessions VALUES (?, ?, ?, ?)').run('a'.repeat(64), 'missing-user', 1, 2), /FOREIGN KEY/);
  app.database.exec("CREATE TRIGGER test_registration_failure BEFORE INSERT ON titoja_profiles BEGIN SELECT RAISE(ABORT, 'synthetic fixture failure'); END");
  const payload = registration('client', fixturePassword());
  const failed = await app.request('/api/auth/register', { method: 'POST', body: payload });
  assert.equal(failed.status, 500);
  assert.ok(!failed.text.includes('synthetic fixture failure'));
  for (const table of ['titoja_users', 'titoja_profiles', 'titoja_sessions']) assert.equal(app.database.prepare('SELECT count(*) AS n FROM ' + table).get().n, 0);
  app.database.exec('DROP TRIGGER test_registration_failure');
  assert.equal((await app.request('/api/auth/register', { method: 'POST', body: payload })).status, 201);
});

test('authentication rate limiting is bounded per socket identity and resets by window', async t => {
  let clock = Date.now();
  const app = await fixture(t, { authRateLimit: { windowMs: 1000, maxAttempts: 2 }, now: () => clock });
  const body = { email: 'missing@fixture.test', password: fixturePassword() };
  assert.equal((await app.request('/api/auth/login', { method: 'POST', body })).status, 401);
  assert.equal((await app.request('/api/auth/login', { method: 'POST', body })).status, 401);
  const limited = await app.request('/api/auth/login', { method: 'POST', body, headers: { 'X-Forwarded-For': '198.51.100.20' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.response.headers.get('retry-after')) >= 1);
  clock += 1001;
  assert.equal((await app.request('/api/auth/login', { method: 'POST', body })).status, 401);
});

test('password reset is explicitly unavailable and never issues a reset token', async t => {
  const app = await fixture(t);
  const result = await app.request('/api/auth/password-reset', { method: 'POST', body: { email: 'missing@fixture.test' } });
  assert.equal(result.status, 501);
  assert.ok(result.json.error.includes('indisponível'));
  assert.equal(result.cookie, null);
  assert.deepEqual(Object.keys(result.json), ['error']);
});

test('explicit loopback proxy trust accepts only a single valid forwarded IP', async t => {
  const app = await fixture(t, { trustLoopbackProxy: true, authRateLimit: { windowMs: 900000, maxAttempts: 1 } });
  const body = { email: 'missing@fixture.test', password: fixturePassword() };
  const login = forwarded => app.request('/api/auth/login', { method: 'POST', body, headers: { 'X-Forwarded-For': forwarded } });
  assert.equal((await login('198.51.100.1')).status, 401);
  assert.equal((await login('198.51.100.1')).status, 429);
  assert.equal((await login('198.51.100.2')).status, 401);
  assert.equal((await login('198.51.100.3, 198.51.100.4')).status, 401);
  assert.equal((await login('not-an-address')).status, 429, 'Invalid chains fall back to the socket bucket');
});

test('map configuration is public, credential-free and account CSP remains strict', async t => {
  const app = await fixture(t);
  const map = await app.request('/api/map-config');
  assert.equal(map.status, 200);
  assert.deepEqual(map.json, { tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' });
  const account = await app.request('/');
  assert.ok(!account.response.headers.get('content-security-policy').includes("'unsafe-inline'"));
  assert.equal(account.response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.ok(account.response.headers.get('permissions-policy').includes('geolocation=(self)'));
  for (const mapTileUrl of [
    'http://tiles.fixture.test/{z}/{x}/{y}.png',
    'https://user:password@tiles.fixture.test/{z}/{x}/{y}.png',
    'https://tiles.fixture.test/{z}/{x}/{y}.png?key=private',
    'https://tiles.fixture.test/{z}/{x}/{y}.png#private',
    'https://tiles.fixture.test/not-an-xyz.png',
  ]) assert.throws(() => createApp({ databasePath: ':memory:', origin, mapTileUrl }));
});

test('tampered and duplicate cookies cannot impersonate an account', async t => {
  const app = await fixture(t);
  const account = await app.request('/api/auth/register', { method: 'POST', body: registration('client', fixturePassword()) });
  assert.equal((await app.request('/api/account', { cookie: 'titoja_session=' + 'A'.repeat(43) })).status, 401);
  assert.equal((await app.request('/api/account', { cookie: account.cookie + '; ' + account.cookie })).status, 401);
  assert.equal((await app.request('/api/account?userId=someone-else', { cookie: account.cookie })).json.profile.user_id, account.json.profile.user_id);
});

test('serves only approved assets and blocks traversal, database files and platform artifacts', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('/health')).status, 200);
  const account = await app.request('/');
  assert.equal(account.status, 200);
  assert.ok(account.response.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal(account.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(account.response.headers.get('cache-control'), 'no-store');
  for (const path of ['/.env', '/.git/config', '/.openai/hosting.json', '/server/app.ts', '/data/titoja.sqlite', '/demo/%2e%2e%2f%2e%2e%2fpackage.json']) {
    assert.equal((await app.request(path)).status, 404);
  }
  assert.equal((await app.request('/api/db-verification', { method: 'POST', body: {} })).status, 410);
});

test('embedded SQLite version, foreign keys and startup configuration are checked', async t => {
  const app = await fixture(t);
  const version = String(app.database.prepare('SELECT sqlite_version() AS version').get().version);
  assert.ok(supportedSqliteVersion(version), 'The tested runtime meets the embedded SQLite minimum');
  assert.equal(app.database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(supportedSqliteVersion('3.50.3'), false);
  assert.equal(supportedSqliteVersion('3.50.4'), true);
  assert.equal(supportedSqliteVersion('3.51.0'), true);
  for (const config of [
    { origin: 'http://non-loopback.fixture.test' },
    { origin: 'https://fixture.test', secureCookies: false },
    { origin: 'https://fixture.test/private-path' },
    { origin: 'invalid-origin' },
  ]) assert.throws(() => createApp({ databasePath: ':memory:', ...config }));
});

test('modified migration history fails closed on reopen', async t => {
  const app = await fixture(t);
  app.database.prepare("UPDATE schema_migrations SET checksum = 'synthetic-fixture-change' WHERE version = 1").run();
  await assert.rejects(() => app.restart(), /applied migration was modified/);
});

test('authenticated responses identify their session and stale tabs cannot mutate another account', async t => {
  const app = await fixture(t);
  const signup = async (role, email) => {
    const result = await app.request('/api/auth/register', { method: 'POST', body: registration(role, fixturePassword(), email) });
    assert.equal(result.status, 201);
    assert.equal(result.response.headers.get('x-titoja-user'), result.json.profile.user_id);
    return { cookie: result.cookie, id: result.json.profile.user_id };
  };
  const customer = await signup('client', 'pinned-customer@fixture.test');
  const changedCustomer = await signup('client', 'changed-customer@fixture.test');
  const owner = await signup('establishment', 'pinned-owner@fixture.test');
  const driver = await signup('driver', 'pinned-driver@fixture.test');
  const pinned = (account, expectedId = account.id) => ({ cookie: account.cookie, headers: { 'X-Titoja-User': expectedId } });
  const stale = async (path, account, method, body) => {
    const result = await app.request(path, { ...pinned(account, customer.id), method, body });
    assert.equal(result.status, 409);
    assert.equal(result.json.code, 'SESSION_CHANGED');
    assert.equal(result.response.headers.get('x-titoja-user'), account.id, 'The response describes the actual cookie identity');
    return result;
  };
  assert.equal((await app.request('/api/account', pinned(customer))).response.headers.get('x-titoja-user'), customer.id);
  assert.equal((await app.request('/api/dashboard?role=client', pinned(customer))).response.headers.get('x-titoja-user'), customer.id);
  assert.equal((await app.request('/api/account', { headers: { 'X-Titoja-User': customer.id } })).status, 401, 'The pin never authenticates a request');
  for (const path of ['/api/stores', '/api/map-config', '/health']) {
    assert.equal((await app.request(path, pinned(customer))).response.headers.get('x-titoja-user'), null, 'Public routes do not reveal the signed-in account');
  }
  const request = { service: 'moto', requestId: randomUUID(), pickupAddress: 'Synthetic pickup 100', pickupArea: 'Synthetic origin', dropoffAddress: 'Synthetic destination 200', dropoffArea: 'Synthetic destination' };
  await stale('/api/orders', changedCustomer, 'POST', request);
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_orders').get().n, 0);
  const logout = await stale('/api/auth/logout', changedCustomer, 'POST', {});
  assert.equal(logout.cookie, null, 'A stale logout must not clear the new account cookie');
  assert.equal((await app.request('/api/account', pinned(changedCustomer))).status, 200, 'The current account session survives the stale logout');
  const created = await app.request('/api/orders', { ...pinned(customer), method: 'POST', body: request });
  assert.equal(created.status, 201);
  const order = created.json.order;
  await stale(`/api/orders/${order.id}/accept`, driver, 'POST', { expectedVersion: 1 });
  assert.equal(app.database.prepare('SELECT worker_id FROM titoja_orders WHERE id = ?').get(order.id).worker_id, null);
  assert.equal((await app.request(`/api/orders/${order.id}/accept`, { ...pinned(driver), method: 'POST', body: { expectedVersion: 1 } })).status, 200);
  await stale(`/api/orders/${order.id}/transition`, driver, 'POST', { action: 'goPickup', expectedVersion: 2 });
  assert.equal(app.database.prepare('SELECT status FROM titoja_orders WHERE id = ?').get(order.id).status, 'assigned');
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_order_events WHERE order_id = ?').get(order.id).n, 2);
  await stale(`/api/orders/${order.id}/location`, driver, 'POST', { latitude: 1, longitude: 2, accuracy: 3 });
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_order_locations').get().n, 0);
  assert.equal((await app.request(`/api/orders/${order.id}/location`, { ...pinned(driver), method: 'POST', body: { latitude: 1, longitude: 2, accuracy: 3 } })).status, 200);
  await stale(`/api/orders/${order.id}/location`, driver, 'DELETE', {});
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_order_locations').get().n, 1);
  const store = { category: 'food', name: 'Synthetic shop', pickupAddress: 'Synthetic pickup 100', pickupArea: 'Synthetic area', isOpen: true, isPublished: true };
  await stale('/api/store', owner, 'PUT', store);
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_stores').get().n, 0);
  const saved = await app.request('/api/store', { ...pinned(owner), method: 'PUT', body: store });
  assert.equal(saved.status, 200);
  await stale('/api/store/products', owner, 'POST', { name: 'Synthetic item', priceCents: 100 });
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM titoja_products').get().n, 0);
  const product = await app.request('/api/store/products', { ...pinned(owner), method: 'POST', body: { name: 'Synthetic item', priceCents: 100 } });
  assert.equal(product.status, 201);
  await stale(`/api/store/products/${product.json.product.id}`, owner, 'PATCH', { priceCents: 1 });
  assert.equal(app.database.prepare('SELECT price_cents FROM titoja_products').get().price_cents, 100);
  assert.equal((await app.request(`/api/stores/${saved.json.store.id}`, pinned(owner))).response.headers.get('x-titoja-user'), null);
  const legacyClient = await app.request('/api/orders', { cookie: changedCustomer.cookie, method: 'POST', body: { ...request, requestId: randomUUID() } });
  assert.equal(legacyClient.status, 201, 'Existing API clients may omit the optional pin');
});
