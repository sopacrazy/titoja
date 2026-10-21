import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../dist/server/app.js';

test('all seven services complete through real HTTP accounts, persisted state, store preparation, exclusive assignment and customer confirmation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'titoja-services-'));
  const databasePath = join(directory, 'services.sqlite');
  const origin = 'http://127.0.0.1';
  const config = { databasePath, origin, authRateLimit: { windowMs: 60000, maxAttempts: 1000 } };
  let app = createApp(config);
  let base;
  async function listen() {
    await new Promise(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function request(path, cookie, method = 'GET', payload) {
    const response = await fetch(base + path, { method, headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {})
    }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function signup(role, suffix) {
    const result = await request('/api/auth/register', null, 'POST', {
      email: `synthetic-${suffix}@example.test`, password: 'Synthetic account passphrase only!',
      name: `Synthetic ${suffix}`, role,
      ...(role === 'establishment' ? { establishmentName: `Synthetic ${suffix} store` } : {})
    });
    assert.equal(result.status, 201);
    return { cookie: result.cookie, profile: result.data.profile };
  }
  async function transition(order, actor, action, deliveryCode) {
    const result = await request(`/api/orders/${order.id}/transition`, actor.cookie, 'POST', {
      action, expectedVersion: order.version, ...(deliveryCode ? { deliveryCode } : {})
    });
    assert.equal(result.status, 200, `transition ${action}: ${result.data.error ?? ''}`);
    return result.data.order;
  }
  try {
    await listen();
    assert.deepEqual((await request('/api/stores')).data.stores, []);
    const customer = await signup('client', 'customer');
    const stranger = await signup('client', 'stranger');
    const courier = await signup('courier', 'courier');
    const otherCourier = await signup('courier', 'other-courier');
    const driver = await signup('driver', 'driver');
    const otherDriver = await signup('driver', 'other-driver');
    const stores = new Map();
    for (const category of ['food', 'market', 'pharmacy', 'beer']) {
      const owner = await signup('establishment', category);
      const saved = await request('/api/store', owner.cookie, 'PUT', {
        category, name: `Synthetic ${category} store`, description: 'Synthetic catalog for local integration tests',
        pickupAddress: 'Synthetic pickup address 100', pickupArea: 'Synthetic pickup district',
        pickupLatitude: 0, pickupLongitude: 0, isOpen: true, isPublished: true
      });
      assert.equal(saved.status, 200);
      const product = await request('/api/store/products', owner.cookie, 'POST', {
        name: 'Synthetic non-regulated test item', priceCents: 1234, isAvailable: true
      });
      assert.equal(product.status, 201);
      stores.set(category, { owner, store: saved.data.store, product: product.data.product });
    }
    const completed = [];
    for (const service of ['moto', 'car', 'delivery', 'food', 'market', 'pharmacy', 'beer']) {
      const commercial = stores.get(service);
      const worker = ['moto', 'car'].includes(service) ? driver : courier;
      const competingWorker = worker === driver ? otherDriver : otherCourier;
      const payload = {
        service, requestId: randomUUID(), dropoffAddress: 'Synthetic destination address 200',
        dropoffArea: 'Synthetic destination district', dropoffLatitude: 0.01, dropoffLongitude: 0.02,
        ...(commercial ? { storeId: commercial.store.id, items: [{ productId: commercial.product.id, quantity: 2 }] }
          : { pickupAddress: 'Synthetic pickup address 100', pickupArea: 'Synthetic pickup district', pickupLatitude: 0, pickupLongitude: 0,
            ...(service === 'delivery' ? { deliveryType: 'Documentos / volumes' } : {}) })
      };
      const created = await request('/api/orders', customer.cookie, 'POST', payload);
      assert.equal(created.status, 201, `create ${service}: ${created.data.error ?? ''}`);
      let order = created.data.order;
      assert.equal(order.paymentStatus, 'simulated');
      assert.equal(order.deliveryFeeCents, null);
      assert.equal(order.totalCents, null);
      assert.equal(order.subtotalCents, commercial ? 2468 : null);
      assert.equal((await request(`/api/orders/${order.id}`, stranger.cookie)).status, 404);
      assert.equal((await request('/api/orders', stranger.cookie)).data.orders.length, 0);
      assert.equal((await request(`/api/orders/${order.id}`, worker.cookie)).status, 404);
      const replay = await request('/api/orders', customer.cookie, 'POST', payload);
      assert.equal(replay.status, 200);
      assert.equal(replay.data.order.id, order.id);
      if (commercial) {
        assert.equal((await request('/api/orders/queue', worker.cookie)).data.orders.some(row => row.id === order.id), false);
        for (const action of ['merchantAccept', 'startPreparing', 'markReady']) order = await transition(order, commercial.owner, action);
      }
      const queue = (await request('/api/orders/queue', worker.cookie)).data.orders.find(row => row.id === order.id);
      assert.ok(queue);
      for (const privateField of ['pickupAddress', 'dropoffAddress', 'customerId', 'pickupLatitude', 'dropoffLatitude']) assert.equal(Object.hasOwn(queue, privateField), false);
      const attempts = await Promise.all([worker, competingWorker].map(candidate => request(`/api/orders/${order.id}/accept`, candidate.cookie, 'POST', { expectedVersion: order.version })));
      assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
      const winnerIndex = attempts.findIndex(result => result.status === 200);
      const winner = [worker, competingWorker][winnerIndex];
      const loser = [worker, competingWorker][1 - winnerIndex];
      order = attempts[winnerIndex].data.order;
      assert.equal(order.workerId, winner.profile.user_id);
      assert.equal((await request(`/api/orders/${order.id}`, loser.cookie)).status, 404);
      assert.equal((await request(`/api/orders/${order.id}/delivery-code`, loser.cookie, 'POST', {})).status, 404);
      for (const action of ['goPickup', 'confirmPickup', 'startDelivery']) order = await transition(order, winner, action);
      assert.equal((await request(`/api/orders/${order.id}/location`, winner.cookie, 'POST', { latitude: 0.005, longitude: 0.01, accuracy: 20 })).status, 200);
      const tracking = await request(`/api/orders/${order.id}/location`, customer.cookie);
      assert.equal(tracking.data.latestLocation.latitude, 0.005);
      const confirmation = await request(`/api/orders/${order.id}/delivery-code`, customer.cookie, 'POST', {});
      assert.equal(confirmation.status, 200);
      assert.match(confirmation.data.deliveryCode, /^\d{6}$/);
      // Resume every service after a real server/database close while still active.
      // Assignment, event history, GPS and the hashed confirmation must all survive.
      const beforeRestart = await request(`/api/orders/${order.id}`, customer.cookie);
      await app.close();
      app = createApp(config);
      await listen();
      const afterRestart = await request(`/api/orders/${order.id}`, customer.cookie);
      assert.equal(afterRestart.status, 200);
      assert.deepEqual(afterRestart.data.order, beforeRestart.data.order);
      assert.equal((await request(`/api/orders/${order.id}`, winner.cookie)).data.order.workerId, winner.profile.user_id);
      assert.equal((await request(`/api/orders/${order.id}`, loser.cookie)).status, 404);
      assert.equal((await request(`/api/orders/${order.id}`, stranger.cookie)).status, 404);
      if (commercial) assert.equal((await request(`/api/orders/${order.id}`, commercial.owner.cookie)).data.order.status, 'in_transit');
      order = await transition(order, winner, 'complete', confirmation.data.deliveryCode);
      assert.equal(order.status, 'completed');
      assert.equal(order.latestLocation, null);
      assert.equal(order.history.length, commercial ? 9 : 6);
      assert.equal((await request(`/api/orders/${order.id}/location`, winner.cookie, 'POST', { latitude: 0, longitude: 0, accuracy: 1 })).status, 403);
      completed.push(order.id);
    }
    await app.close();
    app = createApp(config);
    await listen();
    const persisted = await request('/api/orders', customer.cookie);
    assert.equal(persisted.status, 200);
    assert.equal(persisted.data.orders.length, 7);
    assert.deepEqual(new Set(persisted.data.orders.map(order => order.id)), new Set(completed));
    assert.ok(persisted.data.orders.every(order => order.status === 'completed' && order.paymentStatus === 'simulated' && order.latestLocation === null));
    assert.equal((await request('/api/account', customer.cookie)).data.profile.user_id, customer.profile.user_id);
  } finally {
    await app.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
