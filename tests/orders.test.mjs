import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import crypto, { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../dist/server/database.js';
import { OrderService } from '../dist/server/orders.js';
import { CatalogService } from '../dist/server/catalog.js';
import { createApp } from '../dist/server/app.js';

const origin = 'http://127.0.0.1:4173';
const people = {
  clientA: 'client', clientB: 'client', courierA: 'courier', courierB: 'courier',
  driverA: 'driver', driverB: 'driver', storeA: 'establishment', storeB: 'establishment'
};
function fixture(t) {
  const temporaryRoot = resolve(tmpdir());
  const folder = mkdtempSync(join(temporaryRoot, 'titoja-orders-'));
  const path = join(folder, 'fixture.sqlite');
  let database = openDatabase(path);
  let clock = Date.now();
  let service = new OrderService(database, () => clock);
  let catalog = new CatalogService(database, () => clock);
  const accounts = {};
  for (const [id, role] of Object.entries(people)) {
    database.prepare('INSERT INTO titoja_users (id,email,password_hash,created_at) VALUES (?,?,?,?)').run(id, id.toLowerCase() + '@fixture.test', 'fixture-not-authenticatable', new Date(clock).toISOString());
    database.prepare('INSERT INTO titoja_profiles (user_id,role,name,establishment_name,created_at) VALUES (?,?,?,?,?)').run(id, role, 'Fixture ' + id, role === 'establishment' ? 'Fixture Store ' + id : null, new Date(clock).toISOString());
    accounts[id] = { profile: { user_id: id, role, name: 'Fixture ' + id } };
  }
  const request = (id, method, path, body) => {
    const url = new URL(path, origin);
    return service.handle({ method, pathname: url.pathname, url, account: accounts[id], body });
  };
  t.after(() => {
    database.close();
    if (!resolve(folder).startsWith(temporaryRoot + sep) || !folder.includes('titoja-orders-')) throw Error('Unsafe temporary cleanup target');
    rmSync(folder, { recursive: true, force: true });
  });
  return {
    request, accounts, path,
    get database() { return database; },
    get service() { return service; },
    get catalog() { return catalog; },
    advance(ms) { clock += ms; },
    reopen() { database.close(); database = openDatabase(path); service = new OrderService(database, () => clock); catalog = new CatalogService(database, () => clock); },
    commercial(category = 'food', owner = 'storeA') {
      const store = catalog.saveStore(accounts[owner], { category, name: 'Fixture ' + category, pickupAddress: 'Synthetic collection address 100', pickupArea: 'Synthetic origin area', pickupLatitude: 1.25, pickupLongitude: -2.5, isOpen: true, isPublished: true });
      const product = catalog.createProduct(accounts[owner], { name: 'Fixture product', priceCents: 1234, isAvailable: true });
      return { store, product };
    }
  };
}
function direct(service = 'delivery', overrides = {}) {
  return { service, requestId: randomUUID(), pickupAddress: 'Synthetic pickup address 100', dropoffAddress: 'Synthetic destination address 200', pickupArea: 'Synthetic origin area', dropoffArea: 'Synthetic destination area', ...overrides };
}
const order = result => result.body.order;
const fail = (operation, status) => assert.throws(operation, error => error.status === status, 'Expected HTTP status ' + status);
function transition(f, actor, value, action, extras = {}) {
  return order(f.request(actor, 'POST', `/api/orders/${value.id}/transition`, { action, expectedVersion: value.version, ...extras }));
}
function finish(f, worker, value) {
  for (const action of ['goPickup', 'confirmPickup', 'startDelivery']) value = transition(f, worker, value, action);
  const issued = f.request('clientA', 'POST', `/api/orders/${value.id}/delivery-code`, {}).body;
  return transition(f, worker, value, 'complete', { deliveryCode: issued.deliveryCode });
}

test('direct orders persist all ride/delivery types with genuine timestamps, null fares and private pins', t => {
  const f = fixture(t);
  const created = [];
  for (const service of ['moto', 'car', 'delivery']) {
    const result = f.request('clientA', 'POST', '/api/orders', direct(service, { ...(service === 'delivery' ? { deliveryType: 'Documentos / volumes' } : {}), pickupLatitude: 1, pickupLongitude: 2, dropoffLatitude: -3, dropoffLongitude: -4 }));
    assert.equal(result.status, 201);
    const value = order(result);
    assert.equal(value.paymentStatus, 'simulated');
    assert.equal(value.subtotalCents, null);
    assert.equal(value.totalCents, null);
    assert.equal(value.deliveryFeeCents, null);
    assert.equal(value.pickupLatitude, 1);
    assert.equal(value.dropoffLongitude, -4);
    assert.equal(value.history.length, 1);
    assert.equal(value.history[0].actorRole, 'client');
    created.push(value);
  }
  f.reopen();
  const listed = f.request('clientA', 'GET', '/api/orders').body.orders;
  assert.equal(listed.length, 3);
  for (const value of created) assert.deepEqual(order(f.request('clientA', 'GET', '/api/orders/' + value.id)), value);
  assert.deepEqual(f.request('clientB', 'GET', '/api/orders').body.orders, []);
});

test('all four commerce categories use merchant catalogue prices and progress through participant-specific stages', t => {
  const f = fixture(t);
  for (const category of ['food', 'market', 'pharmacy', 'beer']) {
    const { store, product } = f.commercial(category);
    let value = order(f.request('clientA', 'POST', '/api/orders', {
      service: category, requestId: randomUUID(), storeId: store.id, items: [{ productId: product.id, quantity: 2 }],
      dropoffAddress: 'Synthetic destination address 200', dropoffArea: 'Synthetic destination area'
    }));
    assert.equal(value.subtotalCents, 2468);
    assert.equal(value.items[0].unitPriceCents, 1234);
    assert.equal(value.pickupAddress, store.pickup_address);
    assert.equal(value.pickupLatitude, 1.25);
    assert.equal(value.storeOwnerId, 'storeA');
    assert.deepEqual(f.request('courierA', 'GET', '/api/orders/queue').body.orders, []);
    fail(() => f.request('courierA', 'POST', `/api/orders/${value.id}/accept`, { expectedVersion: value.version }), 409);
    fail(() => f.request('storeB', 'POST', `/api/orders/${value.id}/transition`, { action: 'merchantAccept', expectedVersion: value.version }), 404);
    value = transition(f, 'storeA', value, 'merchantAccept');
    value = transition(f, 'storeA', value, 'startPreparing');
    value = transition(f, 'storeA', value, 'markReady');
    assert.equal(f.request('courierA', 'GET', '/api/orders/queue').body.orders.length, 1);
    value = order(f.request('courierA', 'POST', `/api/orders/${value.id}/accept`, { expectedVersion: value.version }));
    value = finish(f, 'courierA', value);
    assert.equal(value.status, 'completed');
    assert.equal(value.paymentStatus, 'simulated');
    assert.equal(value.history.length, 9);
    assert.equal(value.latestLocation, null);
    for (const actor of ['clientA', 'storeA', 'courierA']) assert.equal(order(f.request(actor, 'GET', '/api/orders/' + value.id)).status, 'completed');
  }
});

test('queue excludes exact addresses, user IDs, coordinates, notes and history; roles are reloaded from SQLite', t => {
  const f = fixture(t);
  const value = order(f.request('clientA', 'POST', '/api/orders', direct('delivery', { note: 'Private synthetic note', pickupLatitude: 1, pickupLongitude: 2 })));
  const queue = f.request('courierA', 'GET', '/api/orders/queue').body.orders;
  assert.equal(queue.length, 1);
  assert.deepEqual(Object.keys(queue[0]).sort(), ['canAccept','createdAt','deliveryType','dropoffArea','id','pickupArea','service','status','storeName','version'].sort());
  const serialized = JSON.stringify(queue);
  for (const privateValue of [value.pickupAddress, value.dropoffAddress, value.note, 'clientA']) assert.ok(!serialized.includes(privateValue));
  for (const actor of ['clientB', 'courierA', 'driverA', 'storeA']) {
    fail(() => f.request(actor, 'GET', '/api/orders/' + value.id), 404);
    fail(() => f.request(actor, 'GET', `/api/orders/${value.id}/location`), 404);
    assert.deepEqual(f.request(actor, 'GET', '/api/orders').body.orders, []);
  }
  f.accounts.clientB.profile.role = 'courier';
  fail(() => f.request('clientB', 'GET', '/api/orders/queue'), 403);
  fail(() => f.request('clientB', 'POST', `/api/orders/${value.id}/accept`, { expectedVersion: 1 }), 403);
  fail(() => f.request('driverA', 'POST', `/api/orders/${value.id}/accept`, { expectedVersion: 1 }), 403);
});

test('creation rejects privilege/price spoofing, invalid inputs, cross-store products and mismatched commerce category', t => {
  const f = fixture(t);
  const originalCount = f.database.prepare('SELECT count(*) AS n FROM titoja_orders').get().n;
  for (const body of [
    direct('other'), direct('delivery', { role: 'admin' }), direct('delivery', { customerId: 'clientB' }),
    direct('delivery', { paymentStatus: 'paid' }), direct('delivery', { totalCents: 1 }),
    direct('delivery', { pickupAddress: 'x' }), direct('delivery', { dropoffAddress: '<script>alert(1)</script>' }),
    direct('delivery', { pickupLatitude: 1 }), direct('delivery', { dropoffLatitude: 91, dropoffLongitude: 1 }),
    direct('delivery', { note: 'x'.repeat(1001) }), direct('moto', { deliveryType: 'Documentos' }),
    direct('delivery', { requestId: 'short' }), direct('delivery', { items: [] })
  ]) fail(() => f.request('clientA', 'POST', '/api/orders', body), 400);
  for (const actor of ['courierA', 'driverA', 'storeA']) fail(() => f.request(actor, 'POST', '/api/orders', direct()), 403);
  const a = f.commercial('food', 'storeA');
  const b = f.commercial('food', 'storeB');
  const commerce = { service: 'food', requestId: randomUUID(), storeId: a.store.id, items: [{ productId: a.product.id, quantity: 1 }], dropoffAddress: 'Synthetic delivery address', dropoffArea: 'Synthetic area' };
  for (const changes of [{ items: [{ productId: a.product.id, quantity: 1, unitPriceCents: 1 }] }, { items: [{ productId: a.product.id, quantity: 0 }] }, { items: [{ productId: a.product.id, quantity: 1 }, { productId: a.product.id, quantity: 2 }] }, { pickupAddress: 'Fake store address' }, { pickupLatitude: 1, pickupLongitude: 2 }]) fail(() => f.request('clientA', 'POST', '/api/orders', { ...commerce, ...changes }), 400);
  fail(() => f.request('clientA', 'POST', '/api/orders', { ...commerce, service: 'beer' }), 400);
  fail(() => f.request('clientA', 'POST', '/api/orders', { ...commerce, items: [{ productId: b.product.id, quantity: 1 }] }), 409);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM titoja_orders').get().n, originalCount);
});

test('idempotent retries cannot duplicate orders or reuse a request ID with a changed payload', t => {
  const f = fixture(t);
  const payload = direct();
  const first = f.request('clientA', 'POST', '/api/orders', payload);
  const repeated = f.request('clientA', 'POST', '/api/orders', payload);
  assert.equal(first.status, 201);
  assert.equal(repeated.status, 200);
  assert.equal(order(first).id, order(repeated).id);
  fail(() => f.request('clientA', 'POST', '/api/orders', { ...payload, dropoffArea: 'A different area' }), 409);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM titoja_orders').get().n, 1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM titoja_order_events').get().n, 1);
});

test('exclusive acceptance remains atomic across simultaneous worker threads and separate SQLite connections', async t => {
  const f = fixture(t);
  const value = order(f.request('clientA', 'POST', '/api/orders', direct()));
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  const workers = ['courierA', 'courierB'].map(actor => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openDatabase } = await import(workerData.databaseModule);
      const { OrderService } = await import(workerData.orderModule);
      const db = openDatabase(workerData.path);
      const barrier = new Int32Array(workerData.shared);
      Atomics.add(barrier, 0, 1);
      Atomics.wait(barrier, 1, 0, 10000);
      try {
        const result = new OrderService(db).handle({ method: 'POST', pathname: '/api/orders/' + workerData.id + '/accept', url: new URL('http://127.0.0.1/api/orders'), account: { profile: { user_id: workerData.actor, role: 'courier', name: 'Fixture' } }, body: { expectedVersion: 1 } });
        parentPort.postMessage({ status: result.status, workerId: result.body.order.workerId });
      } catch (error) { parentPort.postMessage({ status: error.status || 500 }); }
      finally { db.close(); }
    })().catch(error => { parentPort.postMessage({ status: 500, error: error.message }); });
  `, { eval: true, workerData: { actor, id: value.id, path: f.path, shared, databaseModule: new URL('../dist/server/database.js', import.meta.url).href, orderModule: new URL('../dist/server/orders.js', import.meta.url).href } }));
  const promises = workers.map(worker => new Promise((resolveResult, reject) => { worker.once('message', resolveResult); worker.once('error', reject); }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const deadline = Date.now() + 10000;
  while (Atomics.load(barrier, 0) < 2 && Date.now() < deadline) await new Promise(resolveTick => setTimeout(resolveTick, 5));
  assert.equal(Atomics.load(barrier, 0), 2, 'Both real connections reached the acceptance barrier');
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1);
  const results = await Promise.all(promises);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const persisted = order(f.request('clientA', 'GET', '/api/orders/' + value.id));
  assert.equal(persisted.status, 'assigned');
  assert.equal(persisted.workerId, results.find(result => result.status === 200).workerId);
  assert.equal(persisted.history.filter(event => event.action === 'accept').length, 1);
});

test('only the assigned compatible worker can advance, old versions and skipped stages do not append history', t => {
  const f = fixture(t);
  let value = order(f.request('clientA', 'POST', '/api/orders', direct('moto')));
  fail(() => f.request('courierA', 'POST', `/api/orders/${value.id}/accept`, { expectedVersion: value.version }), 403);
  value = order(f.request('driverA', 'POST', `/api/orders/${value.id}/accept`, { expectedVersion: value.version }));
  fail(() => transition(f, 'clientA', value, 'goPickup'), 403);
  fail(() => transition(f, 'driverB', value, 'goPickup'), 404);
  fail(() => transition(f, 'driverA', value, 'startDelivery'), 403);
  fail(() => f.request('driverA', 'POST', `/api/orders/${value.id}/transition`, { action: 'goPickup', expectedVersion: 1 }), 409);
  fail(() => f.request('driverA', 'POST', `/api/orders/${value.id}/transition`, { action: 'goPickup', expectedVersion: value.version, role: 'admin' }), 400);
  assert.equal(order(f.request('clientA', 'GET', '/api/orders/' + value.id)).history.length, 2);
  value = finish(f, 'driverA', value);
  assert.equal(value.status, 'completed');
  fail(() => transition(f, 'driverA', value, 'goPickup'), 403);
  assert.equal(f.request('driverA', 'GET', '/api/orders').body.orders.length, 1);
});

test('delivery confirmation code is customer-only, salted/hashed, rotated, attempt-limited and never exposed in order views', t => {
  const f = fixture(t);
  let value = order(f.request('clientA', 'POST', '/api/orders', direct()));
  fail(() => f.request('clientA', 'POST', `/api/orders/${value.id}/delivery-code`, {}), 403);
  value = order(f.request('courierA', 'POST', `/api/orders/${value.id}/accept`, { expectedVersion: 1 }));
  const code = f.request('clientA', 'POST', `/api/orders/${value.id}/delivery-code`, {}).body;
  assert.match(code.deliveryCode, /^\d{6}$/);
  assert.ok(Date.parse(code.expiresAt) > Date.now());
  for (const actor of ['courierA', 'storeA', 'clientB']) fail(() => f.request(actor, 'POST', `/api/orders/${value.id}/delivery-code`, {}), actor === 'courierA' ? 403 : 404);
  const stored = f.database.prepare('SELECT * FROM titoja_delivery_codes WHERE order_id = ?').get(value.id);
  assert.match(stored.code_hash, /^[a-f0-9]{64}$/);
  assert.match(stored.salt, /^[a-f0-9]{32}$/);
  assert.notEqual(stored.code_hash, code.deliveryCode);
  for (const actor of ['clientA', 'courierA']) {
    const serialized = JSON.stringify(order(f.request(actor, 'GET', '/api/orders/' + value.id)));
    assert.ok(!serialized.includes('code_hash'));
    assert.ok(!serialized.includes(stored.code_hash));
    assert.ok(!serialized.includes('deliveryCode'));
  }
  for (const action of ['goPickup', 'confirmPickup', 'startDelivery']) value = transition(f, 'courierA', value, action);
  const wrong = code.deliveryCode === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) fail(() => transition(f, 'courierA', value, 'complete', { deliveryCode: wrong }), 403);
  assert.equal(f.database.prepare('SELECT attempts FROM titoja_delivery_codes WHERE order_id = ?').get(value.id).attempts, 5);
  fail(() => transition(f, 'courierA', value, 'complete', { deliveryCode: code.deliveryCode }), 429);
  // Force the first cryptographic candidate to collide with the old code, then provide a distinct candidate.
  // Resynchronizing built-in bindings lets this exercise the real production generator without adding a test-only API.
  const originalRandomInt = crypto.randomInt;
  const previousInteger = Number(code.deliveryCode);
  const nextInteger = (previousInteger + 1) % 1000000;
  let candidates = 0;
  crypto.randomInt = () => (++candidates === 1 ? previousInteger : nextInteger);
  syncBuiltinESMExports();
  let rotated;
  try { rotated = f.request('clientA', 'POST', `/api/orders/${value.id}/delivery-code`, {}).body; }
  finally { crypto.randomInt = originalRandomInt; syncBuiltinESMExports(); }
  assert.equal(candidates, 2, 'The colliding code must be discarded');
  assert.notEqual(rotated.deliveryCode, code.deliveryCode);
  assert.notEqual(f.database.prepare('SELECT salt FROM titoja_delivery_codes WHERE order_id = ?').get(value.id).salt, stored.salt);
  fail(() => transition(f, 'courierA', value, 'complete', { deliveryCode: code.deliveryCode }), 403);
  value = transition(f, 'courierA', value, 'complete', { deliveryCode: rotated.deliveryCode });
  assert.equal(value.status, 'completed');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM titoja_delivery_codes WHERE order_id = ?').get(value.id).n, 0);
  fail(() => transition(f, 'courierA', value, 'complete', { deliveryCode: rotated.deliveryCode }), 403);
});

test('expired delivery codes cannot complete; location is participant-only, honest about age and cleared when stopped or completed', t => {
  const f = fixture(t);
  let value = order(f.request('clientA', 'POST', '/api/orders', direct()));
  value = order(f.request('courierA', 'POST', `/api/orders/${value.id}/accept`, { expectedVersion: 1 }));
  for (const actor of ['clientA', 'courierB']) fail(() => f.request(actor, 'POST', `/api/orders/${value.id}/location`, { latitude: 1, longitude: 2, accuracy: 3 }), actor === 'clientA' ? 403 : 404);
  for (const invalid of [{ latitude: 91, longitude: 2, accuracy: 3 }, { latitude: 1, longitude: 2, accuracy: -1 }, { latitude: 1, longitude: 2, accuracy: 3, workerId: 'courierB' }]) fail(() => f.request('courierA', 'POST', `/api/orders/${value.id}/location`, invalid), 400);
  const location = f.request('courierA', 'POST', `/api/orders/${value.id}/location`, { latitude: 1.1, longitude: -2.2, accuracy: 30 }).body.latestLocation;
  assert.equal(location.stale, false);
  assert.equal(order(f.request('clientA', 'GET', '/api/orders/' + value.id)).latestLocation.latitude, 1.1);
  f.advance(120001);
  assert.equal(f.request('clientA', 'GET', `/api/orders/${value.id}/location`).body.latestLocation.stale, true);
  assert.equal(f.request('courierA', 'DELETE', `/api/orders/${value.id}/location`, {}).body.latestLocation, null);
  for (const action of ['goPickup', 'confirmPickup', 'startDelivery']) value = transition(f, 'courierA', value, action);
  const expired = f.request('clientA', 'POST', `/api/orders/${value.id}/delivery-code`, {}).body;
  f.advance(900001);
  fail(() => transition(f, 'courierA', value, 'complete', { deliveryCode: expired.deliveryCode }), 403);
  f.request('courierA', 'POST', `/api/orders/${value.id}/location`, { latitude: 4.4, longitude: 5.5, accuracy: 10 });
  const fresh = f.request('clientA', 'POST', `/api/orders/${value.id}/delivery-code`, {}).body;
  value = transition(f, 'courierA', value, 'complete', { deliveryCode: fresh.deliveryCode });
  assert.equal(value.latestLocation, null);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM titoja_order_locations WHERE order_id = ?').get(value.id).n, 0);
  assert.equal(f.request('courierA', 'DELETE', `/api/orders/${value.id}/location`, {}).body.latestLocation, null);
  fail(() => f.request('courierA', 'POST', `/api/orders/${value.id}/location`, { latitude: 1, longitude: 2, accuracy: 3 }), 403);
});

test('cancel/reject permissions and worker active-order uniqueness remain enforced', t => {
  const f = fixture(t);
  let value = order(f.request('clientA', 'POST', '/api/orders', direct()));
  value = transition(f, 'clientA', value, 'cancel');
  assert.equal(value.status, 'cancelled');
  fail(() => f.request('courierA', 'POST', `/api/orders/${value.id}/accept`, { expectedVersion: value.version }), 409);
  const first = order(f.request('clientA', 'POST', '/api/orders', direct()));
  const second = order(f.request('clientA', 'POST', '/api/orders', direct()));
  const accepted = order(f.request('courierA', 'POST', `/api/orders/${first.id}/accept`, { expectedVersion: 1 }));
  fail(() => transition(f, 'clientA', accepted, 'cancel'), 403);
  fail(() => f.request('courierA', 'POST', `/api/orders/${second.id}/accept`, { expectedVersion: 1 }), 409);
  assert.throws(() => f.database.prepare("UPDATE titoja_orders SET worker_id='courierA',status='assigned' WHERE id=?").run(second.id), /UNIQUE/);
  assert.throws(() => f.database.prepare("UPDATE titoja_orders SET worker_id='missing-user',status='assigned' WHERE id=?").run(second.id), /FOREIGN KEY/);
  const { store, product } = f.commercial();
  let merchantOrder = order(f.request('clientA', 'POST', '/api/orders', { service: 'food', requestId: randomUUID(), storeId: store.id, items: [{ productId: product.id, quantity: 1 }], dropoffAddress: 'Synthetic delivery address', dropoffArea: 'Synthetic area' }));
  merchantOrder = transition(f, 'storeA', merchantOrder, 'reject');
  assert.equal(merchantOrder.status, 'rejected');
  assert.deepEqual(f.request('courierB', 'GET', '/api/orders/queue').body.orders.map(row => row.id), [second.id]);
});

test('queue disables acceptance while a courier or driver is busy and enables it again after completion', t => {
  const f = fixture(t);
  for (const [worker, otherWorker, service] of [['courierA', 'courierB', 'delivery'], ['driverA', 'driverB', 'moto']]) {
    const first = order(f.request('clientA', 'POST', '/api/orders', direct(service)));
    const second = order(f.request('clientA', 'POST', '/api/orders', direct(service)));
    assert.equal(f.request(worker, 'GET', '/api/orders/queue').body.orders.find(value => value.id === second.id).canAccept, true);
    const accepted = order(f.request(worker, 'POST', `/api/orders/${first.id}/accept`, { expectedVersion: first.version }));
    const busyQueue = f.request(worker, 'GET', '/api/orders/queue').body.orders;
    assert.ok(busyQueue.length > 0);
    assert.ok(busyQueue.every(value => value.canAccept === false));
    assert.equal(f.request(otherWorker, 'GET', '/api/orders/queue').body.orders.find(value => value.id === second.id).canAccept, true);
    fail(() => f.request(worker, 'POST', `/api/orders/${second.id}/accept`, { expectedVersion: second.version }), 409);
    finish(f, worker, accepted);
    const availableQueue = f.request(worker, 'GET', '/api/orders/queue').body.orders;
    assert.ok(availableQueue.length > 0);
    assert.ok(availableQueue.every(value => value.canAccept === true));
  }
});

test('failed event writes roll back order creation and transitions atomically', t => {
  const f = fixture(t);
  f.database.exec("CREATE TRIGGER fixture_abort_create BEFORE INSERT ON titoja_order_events WHEN NEW.action='create' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => f.request('clientA', 'POST', '/api/orders', direct()), /fixture failure/);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM titoja_orders').get().n, 0);
  f.database.exec('DROP TRIGGER fixture_abort_create');
  let value = order(f.request('clientA', 'POST', '/api/orders', direct()));
  value = order(f.request('courierA', 'POST', `/api/orders/${value.id}/accept`, { expectedVersion: 1 }));
  f.database.exec("CREATE TRIGGER fixture_abort_transition BEFORE INSERT ON titoja_order_events WHEN NEW.action='goPickup' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => transition(f, 'courierA', value, 'goPickup'), /fixture failure/);
  const persisted = order(f.request('clientA', 'GET', '/api/orders/' + value.id));
  assert.equal(persisted.status, 'assigned');
  assert.equal(persisted.version, value.version);
  assert.equal(persisted.history.length, 2);
});

test('real HTTP sessions connect separate client, store and couriers through a complete persisted commercial order', async t => {
  const temporaryRoot = resolve(tmpdir());
  const folder = mkdtempSync(join(temporaryRoot, 'titoja-order-http-'));
  const databasePath = join(folder, 'fixture.sqlite');
  let app = createApp({ databasePath, origin, authRateLimit: { windowMs: 900000, maxAttempts: 1000 } });
  let base;
  async function start() { app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); base = 'http://127.0.0.1:' + app.server.address().port; }
  await start();
  t.after(async () => {
    await app.close();
    if (!resolve(folder).startsWith(temporaryRoot + sep) || !folder.includes('titoja-order-http-')) throw Error('Unsafe temporary cleanup target');
    rmSync(folder, { recursive: true, force: true });
  });
  async function request(path, method = 'GET', cookie, body, mutationOrigin = origin) {
    const response = await fetch(base + path, { method, headers: { Origin: mutationOrigin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const accounts = {};
  for (const [key, role] of Object.entries({ customer: 'client', shop: 'establishment', worker: 'courier', otherWorker: 'courier' })) {
    const result = await request('/api/auth/register', 'POST', undefined, { email: key.toLowerCase() + '@fixture.test', password: 'fixture-passphrase-' + randomUUID(), name: 'Fixture ' + key, role, ...(role === 'establishment' ? { establishmentName: 'Fixture Store' } : {}) });
    assert.equal(result.status, 201);
    accounts[key] = result.cookie;
  }
  assert.equal((await request('/api/orders')).status, 401);
  const stored = await request('/api/store', 'PUT', accounts.shop, { category: 'food', name: 'Fixture Store', pickupAddress: 'Synthetic collection address', pickupArea: 'Synthetic origin area', isOpen: true, isPublished: true });
  assert.equal(stored.status, 200);
  const product = await request('/api/store/products', 'POST', accounts.shop, { name: 'Fixture product', priceCents: 500, isAvailable: true });
  assert.equal(product.status, 201);
  const payload = { service: 'food', requestId: randomUUID(), storeId: stored.body.store.id, items: [{ productId: product.body.product.id, quantity: 3 }], dropoffAddress: 'Synthetic delivery address', dropoffArea: 'Synthetic destination area' };
  assert.equal((await request('/api/orders', 'POST', accounts.customer, payload, 'https://evil.fixture.test')).status, 403);
  let result = await request('/api/orders', 'POST', accounts.customer, payload);
  assert.equal(result.status, 201);
  let value = result.body.order;
  for (const action of ['merchantAccept', 'startPreparing', 'markReady']) {
    result = await request(`/api/orders/${value.id}/transition`, 'POST', accounts.shop, { action, expectedVersion: value.version });
    assert.equal(result.status, 200);
    value = result.body.order;
  }
  const offers = await request('/api/orders/queue', 'GET', accounts.worker);
  assert.equal(offers.body.orders.length, 1);
  const races = await Promise.all([accounts.worker, accounts.otherWorker].map(cookie => request(`/api/orders/${value.id}/accept`, 'POST', cookie, { expectedVersion: value.version })));
  assert.deepEqual(races.map(value => value.status).sort(), [200, 409]);
  const winner = races[0].status === 200 ? accounts.worker : accounts.otherWorker;
  const loser = races[0].status === 200 ? accounts.otherWorker : accounts.worker;
  value = races.find(value => value.status === 200).body.order;
  assert.equal((await request('/api/orders/' + value.id, 'GET', loser)).status, 404);
  for (const action of ['goPickup', 'confirmPickup', 'startDelivery']) {
    result = await request(`/api/orders/${value.id}/transition`, 'POST', winner, { action, expectedVersion: value.version });
    assert.equal(result.status, 200);
    value = result.body.order;
  }
  const code = await request(`/api/orders/${value.id}/delivery-code`, 'POST', accounts.customer, {});
  assert.equal(code.status, 200);
  result = await request(`/api/orders/${value.id}/transition`, 'POST', winner, { action: 'complete', expectedVersion: value.version, deliveryCode: code.body.deliveryCode });
  assert.equal(result.status, 200);
  assert.equal(result.body.order.status, 'completed');
  assert.equal(result.body.order.subtotalCents, 1500);
  assert.equal(result.body.order.paymentStatus, 'simulated');
  await app.close();
  app = createApp({ databasePath, origin, authRateLimit: { windowMs: 900000, maxAttempts: 1000 } });
  await start();
  const persisted = await request('/api/orders/' + value.id, 'GET', accounts.customer);
  assert.equal(persisted.status, 200);
  assert.equal(persisted.body.order.status, 'completed');
  assert.equal(persisted.body.order.history.length, 9);
});
