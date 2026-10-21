import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { CatalogService } from '../dist/server/catalog.js';

const storeInput = (extra = {}) => ({ category: 'food', name: 'Loja Sintética', description: 'Catálogo criado pelo próprio titular', pickupAddress: 'Rua de Teste, 100', pickupArea: 'Bairro de Teste', isOpen: true, isPublished: true, ...extra });
const productInput = (extra = {}) => ({ name: 'Produto de teste', description: 'Item sintético', priceCents: 1250, ...extra });
const hasStatus = status => error => error?.status === status;
function removeFixture(directory) {
  const absolute = resolve(directory);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + sep));
  assert.match(absolute.split(sep).at(-1), /^titoja-catalog-/);
  rmSync(absolute, { recursive: true, force: true });
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'titoja-catalog-'));
  const path = join(directory, 'catalog.sqlite');
  const setup = new DatabaseSync(path);
  setup.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  for (const name of ['0001_accounts.sql', '0002_catalog.sql']) setup.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  for (const [userId, role] of [['owner-a', 'establishment'], ['owner-b', 'establishment'], ['client', 'client'], ['courier', 'courier']]) {
    setup.prepare('INSERT INTO titoja_users(id,email,password_hash,created_at) VALUES (?,?,?,?)').run(userId, userId + '@example.test', 'not-used-by-catalog-unit-tests', '2026-01-01T00:00:00.000Z');
    setup.prepare('INSERT INTO titoja_profiles(user_id,role,name,establishment_name,created_at) VALUES (?,?,?,?,?)').run(userId, role, 'Pessoa Sintética ' + userId, role === 'establishment' ? 'Loja Sintética ' + userId : null, '2026-01-01T00:00:00.000Z');
  }
  const f = { directory, path, db: setup, service: new CatalogService(setup, () => 1_800_000_000_000) };
  f.actor = (userId, role = 'establishment') => ({ profile: { user_id: userId, role } });
  f.reopen = () => {
    f.db.close();
    f.db = new DatabaseSync(path);
    f.db.exec('PRAGMA foreign_keys = ON;');
    f.service = new CatalogService(f.db);
  };
  t.after(() => { if (f.db.isOpen) f.db.close(); removeFixture(directory); });
  return f;
}

test('catalog starts empty and does not seed operational stores or products', t => {
  const f = fixture(t);
  assert.deepEqual(f.service.listStores(), []);
  assert.equal(f.service.getOwnStore(f.actor('owner-a')), null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM titoja_products').get().n, 0);
  assert.throws(() => f.service.getPublicStore('00000000-0000-0000-0000-000000000000'), hasStatus(404));
});

test('only the stored establishment role can manage a store, regardless of claimed account role', t => {
  const f = fixture(t);
  assert.throws(() => f.service.saveStore(null, storeInput()), hasStatus(401));
  for (const userId of ['client', 'courier']) {
    const forged = f.actor(userId, 'establishment');
    assert.throws(() => f.service.getOwnStore(forged), hasStatus(403));
    assert.throws(() => f.service.saveStore(forged, storeInput()), hasStatus(403));
    assert.throws(() => f.service.createProduct(forged, productInput()), hasStatus(403));
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM titoja_stores').get().n, 0);
});

test('one owner has one persistent store; drafts and precise pickup details remain private', t => {
  const f = fixture(t), owner = f.actor('owner-a');
  const draft = f.service.saveStore(owner, storeInput({ isOpen: false, isPublished: false, pickupLatitude: 0, pickupLongitude: 0 }));
  assert.deepEqual(f.service.listStores(), []);
  assert.throws(() => f.service.getPublicStore(draft.id), hasStatus(404));
  const published = f.service.saveStore(owner, storeInput({ pickupLatitude: 1.25, pickupLongitude: -2.5 }));
  assert.equal(published.id, draft.id);
  assert.equal(published.created_at, draft.created_at);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM titoja_stores WHERE owner_id = ?').get('owner-a').n, 1);
  const product = f.service.createProduct(owner, productInput());
  const listing = f.service.listStores('food');
  assert.equal(listing[0].products_count, 1);
  assert.equal(listing[0].is_open, true);
  for (const record of [listing[0], f.service.getPublicStore(published.id)]) {
    for (const field of ['owner_id', 'pickup_address', 'pickup_latitude', 'pickup_longitude', 'email']) assert.equal(Object.hasOwn(record, field), false);
  }
  assert.equal(f.service.getPublicStore(published.id).products[0].id, product.id);
  assert.equal(f.service.getOwnStore(owner).pickup_latitude, 1.25);
  f.reopen();
  assert.equal(f.service.getOwnStore(owner).products[0].price_cents, 1250);
  assert.equal(f.service.getOwnStore(owner).pickup_address, 'Rua de Teste, 100');
});

test('owners cannot inject identity fields, move products or mutate another store product', t => {
  const f = fixture(t), a = f.actor('owner-a'), b = f.actor('owner-b');
  const first = f.service.saveStore(a, storeInput({ name: 'Loja Sintética A' }));
  const second = f.service.saveStore(b, storeInput({ name: 'Loja Sintética B' }));
  const foreign = f.service.createProduct(b, productInput({ priceCents: 4500 }));
  assert.throws(() => f.service.saveStore(a, storeInput({ ownerId: 'owner-b' })), hasStatus(400));
  assert.throws(() => f.service.createProduct(a, productInput({ storeId: second.id })), hasStatus(400));
  assert.throws(() => f.service.updateProduct(a, foreign.id, { priceCents: 1 }), hasStatus(404));
  assert.throws(() => f.service.updateProduct(b, foreign.id, { store_id: first.id }), hasStatus(400));
  assert.equal(f.service.getOwnStore(a).products.length, 0);
  assert.equal(f.service.getOwnStore(b).products[0].price_cents, 4500);
});

test('parameterized text cannot execute SQL and fields are validated before writes', t => {
  const f = fixture(t), owner = f.actor('owner-a');
  const sqlText = "Loja '); DROP TABLE titoja_users; --";
  const store = f.service.saveStore(owner, storeInput({ name: sqlText }));
  assert.equal(store.name, sqlText);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM titoja_users').get().n, 4);
  for (const bad of [{ name: '<script>alert(1)</script>' }, { name: 'x' }, { name: 'x'.repeat(101) }, { category: 'admin' }, { isOpen: 'true' }, { pickupAddress: 'x' }, { description: 'x'.repeat(1001) }]) {
    assert.throws(() => f.service.saveStore(owner, storeInput(bad)), hasStatus(400));
  }
  for (const bad of [{ userId: 'owner-b' }, { owner_id: 'owner-b' }, { isAdmin: true }, JSON.parse('{"__proto__": {"admin": true}}')]) {
    assert.throws(() => f.service.createProduct(owner, productInput(bad)), hasStatus(400));
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM titoja_products').get().n, 0);
  assert.equal(f.service.getOwnStore(owner).name, sqlText);
});

test('prices use integer cents including zero, while unavailability preserves the historical product record', t => {
  const f = fixture(t), owner = f.actor('owner-a');
  const store = f.service.saveStore(owner, storeInput());
  for (const amount of [-1, 0.5, 10_000_001, '10', null, NaN, Infinity]) assert.throws(() => f.service.createProduct(owner, productInput({ priceCents: amount })), hasStatus(400));
  const product = f.service.createProduct(owner, productInput({ priceCents: 0 }));
  assert.equal(product.price_cents, 0);
  assert.throws(() => f.service.updateProduct(owner, product.id, { priceCents: 0.25 }), hasStatus(400));
  assert.throws(() => f.service.updateProduct(owner, product.id, {}), hasStatus(400));
  f.service.updateProduct(owner, product.id, { priceCents: 100, isAvailable: false });
  assert.deepEqual(f.service.getPublicStore(store.id).products, []);
  assert.equal(f.service.getOwnStore(owner).products[0].is_available, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM titoja_products').get().n, 1);
  f.service.updateProduct(owner, product.id, { isAvailable: true, description: '' });
  assert.equal(f.service.getPublicStore(store.id).products[0].price_cents, 100);
});

test('pickup coordinate pairs are optional, bounded, persistent and can be cleared explicitly', t => {
  const f = fixture(t), owner = f.actor('owner-a');
  const initial = f.service.saveStore(owner, storeInput({ pickupLatitude: 0, pickupLongitude: 0 }));
  assert.equal(initial.pickup_latitude, 0);
  f.service.saveStore(owner, storeInput());
  assert.equal(f.service.getOwnStore(owner).pickup_longitude, 0);
  for (const pair of [{ pickupLatitude: 1 }, { pickupLongitude: 1 }, { pickupLatitude: 91, pickupLongitude: 0 }, { pickupLatitude: 0, pickupLongitude: 181 }, { pickupLatitude: NaN, pickupLongitude: 0 }, { pickupLatitude: 0, pickupLongitude: Infinity }, { pickupLatitude: '0', pickupLongitude: 0 }, { pickupLatitude: null, pickupLongitude: 0 }]) {
    assert.throws(() => f.service.saveStore(owner, storeInput(pair)), hasStatus(400));
  }
  const cleared = f.service.saveStore(owner, storeInput({ pickupLatitude: null, pickupLongitude: null }));
  assert.equal(cleared.pickup_latitude, null);
  assert.equal(cleared.pickup_longitude, null);
});

test('commercial quote reads prices, category and availability exclusively from the store database', t => {
  const f = fixture(t), owner = f.actor('owner-a'), other = f.actor('owner-b');
  const store = f.service.saveStore(owner, storeInput());
  const first = f.service.createProduct(owner, productInput());
  const free = f.service.createProduct(owner, productInput({ name: 'Amostra de teste', priceCents: 0 }));
  f.service.saveStore(other, storeInput({ name: 'Outra Loja', category: 'beer' }));
  const foreign = f.service.createProduct(other, productInput());
  const items = [{ productId: first.id, quantity: 3 }, { productId: free.id, quantity: 1 }];
  const quote = f.service.quoteForOrder(store.id, items, 'food');
  assert.equal(quote.subtotal_cents, 3750);
  assert.equal(quote.items[0].unit_price_cents, 1250);
  assert.equal(quote.items[0].line_total_cents, 3750);
  assert.equal(quote.store.owner_id, 'owner-a');
  for (const quantity of [0, 100, 1.5, '1', NaN]) assert.throws(() => f.service.quoteForOrder(store.id, [{ productId: first.id, quantity }], 'food'), hasStatus(400));
  assert.throws(() => f.service.quoteForOrder(store.id, [{ productId: first.id, quantity: 1, unitPriceCents: 1 }], 'food'), hasStatus(400));
  assert.throws(() => f.service.quoteForOrder(store.id, [items[0], items[0]], 'food'), hasStatus(400));
  assert.throws(() => f.service.quoteForOrder(store.id, [], 'food'), hasStatus(400));
  assert.throws(() => f.service.quoteForOrder(store.id, [{ productId: foreign.id, quantity: 1 }], 'food'), hasStatus(409));
  assert.throws(() => f.service.quoteForOrder(store.id, items, 'beer'), hasStatus(400));
  f.service.updateProduct(owner, first.id, { priceCents: 2000, isAvailable: false });
  assert.equal(quote.items[0].unit_price_cents, 1250, 'previous snapshot must not change when product is edited');
  assert.throws(() => f.service.quoteForOrder(store.id, items, 'food'), hasStatus(409));
  f.service.saveStore(owner, storeInput({ isOpen: false }));
  assert.throws(() => f.service.quoteForOrder(store.id, [{ productId: free.id, quantity: 1 }], 'food'), hasStatus(409));
  f.service.saveStore(owner, storeInput({ isPublished: false }));
  assert.throws(() => f.service.quoteForOrder(store.id, [{ productId: free.id, quantity: 1 }], 'food'), hasStatus(404));
});

test('schema enforces foreign keys, immutable ownership and product-store relationships', t => {
  const f = fixture(t), a = f.actor('owner-a'), b = f.actor('owner-b');
  const first = f.service.saveStore(a, storeInput());
  const second = f.service.saveStore(b, storeInput());
  const product = f.service.createProduct(a, productInput());
  assert.equal(f.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => f.db.prepare('UPDATE titoja_stores SET owner_id = ? WHERE id = ?').run('owner-b', first.id));
  assert.throws(() => f.db.prepare('UPDATE titoja_products SET store_id = ? WHERE id = ?').run(second.id, product.id));
  assert.throws(() => f.db.prepare('INSERT INTO titoja_products (id,store_id,name,description,price_cents,is_available,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('orphan', 'missing-store', 'Produto sintético', '', 1, 1, 'test', 'test'));
  assert.throws(() => f.db.prepare('INSERT INTO titoja_stores (id,owner_id,category,name,pickup_address,pickup_area,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('client-store', 'client', 'food', 'Loja inválida', 'Rua de Teste', 'Teste', 'test', 'test'));
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('catalog routing distinguishes public read from owned operations and rejects unsupported mutation shapes', t => {
  const f = fixture(t), account = f.actor('owner-a');
  const handle = (method, pathname, body, actor = account) => f.service.handle({ method, pathname, url: new URL('http://catalog.test' + pathname), account: actor, body });
  assert.deepEqual(handle('GET', '/api/stores', undefined, null), { status: 200, body: { stores: [] } });
  assert.equal(handle('GET', '/api/store', undefined, null).status, 401);
  const saved = handle('PUT', '/api/store', storeInput());
  assert.equal(saved.status, 200);
  const created = handle('POST', '/api/store/products', productInput());
  assert.equal(created.status, 201);
  assert.equal(handle('PATCH', '/api/store/products/' + created.body.product.id, { isAvailable: false }).status, 200);
  assert.equal(handle('DELETE', '/api/store/products/' + created.body.product.id).status, 405);
  assert.equal(handle('POST', '/api/stores', {}).status, 405);
  assert.equal(handle('GET', '/api/stores/not-a-valid-id').status, 404);
  assert.equal(handle('GET', '/not-a-catalog-route'), null);
});

test('HTTP catalog mutations require a real establishment session and same-origin protection', async t => {
  const { createApp } = await import('../dist/server/app.js');
  const directory = mkdtempSync(join(tmpdir(), 'titoja-catalog-'));
  const origin = 'http://127.0.0.1:4173';
  const app = createApp({ databasePath: join(directory, 'http.sqlite'), origin, authRateLimit: { windowMs: 60_000, maxAttempts: 100 } });
  await new Promise(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => { await app.close(); removeFixture(directory); });
  const request = (path, method = 'GET', body, cookie, requestOrigin = origin) => fetch(base + path, { method, headers: { Origin: requestOrigin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const signup = async (email, role) => {
    const response = await request('/api/auth/register', 'POST', { email, password: 'Synthetic-test-passphrase-2026', name: 'Pessoa Sintética', role, ...(role === 'establishment' ? { establishmentName: 'Loja Sintética' } : {}) });
    assert.equal(response.status, 201);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const owner = await signup('http-owner@example.test', 'establishment');
  const client = await signup('http-client@example.test', 'client');
  assert.equal((await request('/api/store', 'PUT', storeInput())).status, 401);
  assert.equal((await request('/api/store', 'PUT', storeInput(), client)).status, 403);
  assert.equal((await request('/api/store', 'PUT', storeInput(), owner, 'https://untrusted.example.test')).status, 403);
  const saved = await request('/api/store', 'PUT', storeInput(), owner);
  assert.equal(saved.status, 200);
  const store = (await saved.json()).store;
  const product = await request('/api/store/products', 'POST', productInput(), owner);
  assert.equal(product.status, 201);
  const listed = await request('/api/stores?category=food');
  assert.equal(listed.status, 200);
  const publicStore = (await (await request('/api/stores/' + store.id)).json()).store;
  assert.equal(publicStore.products.length, 1);
  assert.equal(Object.hasOwn(publicStore, 'pickup_address'), false);
  assert.equal(Object.hasOwn(publicStore, 'owner_id'), false);
});
