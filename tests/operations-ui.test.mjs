import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/operations.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/operations.js', import.meta.url), 'utf8').replace(/^import .*?;\s*/m, '');
const mapScript = readFileSync(new URL('../public/map.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const user = (role = 'client', id = 'client-a', name = 'Ana Cliente') => ({ user_id: id, role, name });
const order = (id = 'order-a', overrides = {}) => ({
  id, service: 'delivery', deliveryType: 'Documento', status: 'requested', version: 1,
  pickupAddress: 'Rua Origem, 10', dropoffAddress: 'Rua Destino, 20', pickupArea: 'Centro', dropoffArea: 'Jardim',
  createdAt: '2026-01-01T12:00:00.000Z', availableActions: ['cancel'], history: [], ...overrides,
});
const store = {
  id: 'store-a', name: 'Cozinha de teste', category: 'food', description: 'Catálogo de teste', pickup_area: 'Centro', is_open: true,
  products: [{ id: 'product-a', name: 'Produto A', description: 'Descrição', price_cents: 1234, is_available: true },
    { id: 'product-b', name: 'Produto B', description: '', price_cents: 500, is_available: true }],
};
const json = (value, status = 200, identity = 'client-a') => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...(identity ? { 'X-Titoja-User': identity } : {}) },
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('UI did not settle: ' + description);
}
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

function mount(handler, options = {}) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4173/app/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [], intervals = new Map(), channels = [], mapCalls = [];
  let nextTimer = 0, hidden = false, storageAccesses = 0;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(window, 'isSecureContext', { value: true });
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  Object.defineProperty(window.navigator, 'geolocation', { value: options.geolocation ?? {
    getCurrentPosition() { assert.fail('GPS must require a user action'); },
    watchPosition() { assert.fail('GPS tracking must require a user action'); }, clearWatch() {},
  } });
  window.Headers = Headers;
  window.setInterval = (callback, delay) => { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id; };
  window.clearInterval = id => intervals.delete(id);
  window.BroadcastChannel = class {
    constructor(name) { this.name = name; this.sent = []; channels.push(this); }
    addEventListener(type, callback) { if (type === 'message') this.onmessage = callback; }
    postMessage(value) { this.sent.push(JSON.parse(JSON.stringify(value))); }
  };
  for (const method of ['getItem', 'setItem', 'removeItem', 'clear']) window.Storage.prototype[method] = () => {
    storageAccesses++; throw new Error('Operations must not persist identity or location in browser storage');
  };
  window.fetch = async (path, requestOptions = {}) => {
    const request = { path, options: requestOptions, payload: requestOptions.body ? JSON.parse(requestOptions.body) : undefined };
    calls.push(request);
    return handler(request);
  };
  window.__mountMap = async (container, config) => {
    const instance = { setPoint() {}, setCenter() {}, setTrackedPoint() {}, destroy() { container.replaceChildren(); } };
    mapCalls.push({ container, config, instance });
    return options.mountMap ? options.mountMap(container, config, instance) : instance;
  };
  // Exercise the emitted production UI and actual GPS validation, while keeping map tiles offline.
  window.eval(`const { getCurrentPosition } = (() => { ${mapScript}\nreturn { getCurrentPosition }; })(); const mountMap = window.__mountMap;\n${script}`);
  return {
    dom, window, document: window.document, calls, intervals, channels, mapCalls,
    storageAccesses: () => storageAccesses,
    tick() { for (const timer of [...intervals.values()]) timer.callback(); },
    visibility(value) { hidden = value; window.document.dispatchEvent(new window.Event('visibilitychange')); },
    sessionChanged() { for (const channel of channels) channel.onmessage?.({ data: { type: 'changed' } }); },
  };
}
function fill(ui, selector, fields) {
  const form = ui.document.querySelector(selector);
  for (const [name, value] of Object.entries(fields)) {
    const input = form.elements.namedItem(name);
    if (input.type === 'checkbox') input.checked = value; else input.value = value;
  }
  return form;
}
function submit(ui, form) { form.dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true })); }
function sample(overrides = {}) { return { coords: { latitude: -10.5, longitude: -40.25, accuracy: 14 }, timestamp: Date.now(), ...overrides }; }
async function ready(ui) { await until(() => ui.document.querySelector('#orders-feed .ops-order, #orders-feed .ops-empty'), 'workspace'); }
async function checkout(ui) {
  ui.document.querySelector('[data-service=food]').click();
  await until(() => ui.document.querySelector('[data-store]'), 'stores');
  ui.document.querySelector('[data-store]').click();
  await until(() => ui.document.getElementById('commerce-form'), 'checkout');
}
function commerceApi(request, identity = user()) {
  if (request.path === '/api/account') return json({ profile: identity }, 200, identity.user_id);
  if (request.path === '/api/orders' || request.path === '/api/orders/queue') return json({ orders: [] }, 200, identity.user_id);
  if (request.path.startsWith('/api/stores?')) return json({ stores: [store] }, 200, null);
  if (request.path === '/api/stores/store-a') return json({ store }, 200, null);
  assert.fail('Unexpected request ' + request.path);
}

test('operations starts with seven real services, a single poll and no implicit GPS, map or stored identity', async t => {
  const ui = mount(commerceApi);
  t.after(() => ui.dom.window.close());
  await ready(ui);
  assert.deepEqual([...ui.document.querySelectorAll('[data-service]')].map(button => button.dataset.service), ['moto', 'car', 'delivery', 'food', 'market', 'pharmacy', 'beer']);
  assert.equal(ui.document.getElementById('ops-identity').textContent, 'Cliente · Ana Cliente');
  assert.equal(ui.document.getElementById('ops-store-nav').hidden, true);
  assert.equal(ui.intervals.size, 1);
  assert.equal([...ui.intervals.values()][0].delay, 5000);
  assert.equal(ui.calls.some(call => /map|location/.test(call.path)), false);
  assert.equal(ui.mapCalls.length, 0);
  assert.equal(ui.storageAccesses(), 0);
  for (const call of ui.calls) { assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.cache, 'no-store'); }
  assert.match(ui.document.body.textContent, /pagamento simulado, sem cobrança/i);
});

test('checkout computes the catalog subtotal, sends selected items and explicit GPS once, then follows the server order', async t => {
  const creation = deferred();
  let gpsRequests = 0;
  const ui = mount(request => {
    if (request.path === '/api/orders' && request.options.method === 'POST') return creation.promise;
    if (request.path === '/api/orders/created-a') return json({ order: order('created-a', { service: 'food' }) });
    return commerceApi(request);
  }, { geolocation: { getCurrentPosition(success) { gpsRequests++; success(sample()); }, clearWatch() {} } });
  t.after(() => ui.dom.window.close());
  await ready(ui); await checkout(ui);
  const quantity = ui.document.querySelector('[data-quantity=product-a]');
  quantity.value = '2'; quantity.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  assert.match(ui.document.getElementById('cart-subtotal').textContent, /24,68/);
  ui.document.querySelector('[data-use-location=dropoff]').click();
  await until(() => ui.document.getElementById('pin-dropoff').textContent.includes('14 m'), 'GPS pin');
  const form = fill(ui, '#commerce-form', { dropoffAddress: 'Rua Destino, 20', dropoffArea: 'Jardim', note: 'Observação', paymentSimulation: true });
  submit(ui, form); submit(ui, form);
  await until(() => ui.calls.some(call => call.options.method === 'POST'), 'order creation');
  const posts = ui.calls.filter(call => call.path === '/api/orders' && call.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].payload, { service: 'food', requestId: posts[0].payload.requestId, dropoffAddress: 'Rua Destino, 20', dropoffArea: 'Jardim', note: 'Observação', dropoffLatitude: -10.5, dropoffLongitude: -40.25, storeId: 'store-a', items: [{ productId: 'product-a', quantity: 2 }] });
  assert.match(posts[0].payload.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(posts[0].options.headers.get('X-Titoja-User'), 'client-a');
  assert.equal(form.querySelector('[type=submit]').disabled, true);
  creation.resolve(json({ order: order('created-a') }, 201));
  await until(() => ui.document.getElementById('order-live')?.textContent.includes('created-a'), 'created order');
  assert.equal(gpsRequests, 1);
  assert.equal(ui.calls.some(call => call.path.endsWith('/location')), false);
  assert.equal(ui.storageAccesses(), 0);
});

test('checkout rejects empty carts and polling preserves an unfinished checkout for the same account', async t => {
  const ui = mount(commerceApi);
  t.after(() => ui.dom.window.close());
  await ready(ui); await checkout(ui);
  const form = fill(ui, '#commerce-form', { dropoffAddress: 'Rua Destino, 20', dropoffArea: 'Jardim', paymentSimulation: true });
  submit(ui, form);
  await until(() => ui.document.getElementById('ops-message').textContent.includes('Escolha ao menos'), 'empty cart error');
  assert.equal(ui.calls.some(call => call.options.method === 'POST'), false);
  const before = ui.calls.length;
  ui.tick();
  await until(() => ui.calls.length > before, 'identity poll in checkout');
  await settle();
  assert.equal(ui.document.getElementById('commerce-form'), form);
  assert.equal(form.elements.namedItem('dropoffAddress').value, 'Rua Destino, 20');
  assert.deepEqual(ui.calls.slice(before).map(call => call.path), ['/api/account']);
});

test('GPS denial is honest and a late coordinate or GPS error cannot contaminate another screen', async t => {
  let success, reject;
  const ui = mount(commerceApi, { geolocation: { getCurrentPosition(done, fail) { success = done; reject = fail; }, clearWatch() {} } });
  t.after(() => ui.dom.window.close());
  await ready(ui);
  ui.document.querySelector('[data-service=delivery]').click();
  await until(() => ui.document.getElementById('order-form'), 'direct form');
  ui.document.querySelector('[data-use-location=pickup]').click();
  reject({ code: 1 });
  await until(() => ui.document.getElementById('ops-message').textContent.includes('recusada'), 'GPS denial');
  assert.match(ui.document.getElementById('pin-pickup').textContent, /sem coordenadas/);
  ui.document.querySelector('[data-use-location=pickup]').click();
  ui.document.querySelector('[data-nav=home]').click();
  await ready(ui);
  success(sample());
  await settle();
  assert.equal(ui.document.getElementById('ops-message').textContent, '');
  ui.document.querySelector('[data-service=moto]').click();
  await until(() => ui.document.getElementById('order-form'), 'new direct form');
  assert.match(ui.document.getElementById('pin-pickup').textContent, /sem coordenadas/);
  ui.document.querySelector('[data-use-location=pickup]').click();
  ui.document.querySelector('[data-nav=home]').click();
  await ready(ui); reject({ code: 3 }); await settle();
  assert.equal(ui.document.getElementById('ops-message').textContent, '');
  assert.equal(ui.calls.some(call => call.path.endsWith('/location')), false);
});

test('polling changes the entire account workspace and removes the old checkout, name and permissions', async t => {
  let identity = user();
  const next = user('courier', 'courier-b', 'Bruno Entregador');
  const ui = mount(request => {
    if (request.path === '/api/orders/queue') return json({ orders: [order('offer-b', { canAccept: true })] }, 200, identity.user_id);
    return commerceApi(request, identity);
  });
  t.after(() => ui.dom.window.close());
  await ready(ui); await checkout(ui);
  fill(ui, '#commerce-form', { dropoffAddress: 'Endereço privado da Ana' });
  identity = next;
  ui.tick();
  await until(() => ui.document.querySelector('[data-accept=offer-b]'), 'new courier account');
  assert.equal(ui.document.getElementById('ops-identity').textContent, 'Entregador · Bruno Entregador');
  assert.equal(ui.document.getElementById('commerce-form'), null);
  assert.equal(ui.document.querySelector('[data-service]'), null);
  assert.equal(ui.document.getElementById('ops-store-nav').hidden, true);
  assert.equal(ui.document.body.textContent.includes('Ana'), false);
  assert.equal(ui.document.body.innerHTML.includes('Endereço privado da Ana'), false);
});

for (const staleResult of ['success', 'unauthorized']) test('a stale ' + staleResult + ' poll cannot replace newer data after its request was aborted', async t => {
  const old = deferred();
  let reads = 0;
  const ui = mount(request => {
    if (request.path === '/api/account') return json({ profile: user() });
    if (request.path === '/api/orders') {
      reads++;
      return reads === 2 ? old.promise : json({ orders: [order(reads === 1 ? 'initial' : 'newest')] });
    }
    assert.fail('Unexpected request ' + request.path);
  });
  t.after(() => ui.dom.window.close());
  await ready(ui);
  ui.tick(); await until(() => reads === 2, 'first pending poll');
  const abandoned = ui.calls.at(-1);
  ui.tick(); await until(() => ui.document.querySelector('[data-order=newest]'), 'newest poll');
  assert.equal(abandoned.options.signal.aborted, true);
  old.resolve(staleResult === 'success' ? json({ orders: [order('obsolete-private-order')] }) : json({ error: 'Expired old request' }, 401, null)); await settle();
  assert.ok(ui.document.querySelector('[data-order=newest]'));
  assert.equal(ui.document.getElementById('ops-identity').textContent, 'Cliente · Ana Cliente');
});

test('an expired session detected by polling removes every private record and account control', async t => {
  let authenticated = true;
  const ui = mount(request => {
    if (request.path === '/api/account') return authenticated ? json({ profile: user('establishment', 'store-owner', 'Ana Loja') }, 200, 'store-owner') : json({ error: 'Entre na sua conta' }, 401, null);
    if (request.path === '/api/orders') return json({ orders: [order('private-a')] }, 200, 'store-owner');
    assert.fail('Unexpected request ' + request.path);
  });
  t.after(() => ui.dom.window.close());
  await ready(ui);
  assert.equal(ui.document.getElementById('ops-store-nav').hidden, false);
  authenticated = false; ui.tick();
  await until(() => ui.document.body.textContent.includes('Entre na sua conta'), 'expired session');
  assert.equal(ui.document.body.textContent.includes('Ana'), false);
  assert.equal(ui.document.querySelector('[data-order=private-a]'), null);
  assert.equal(ui.document.getElementById('ops-store-nav').hidden, true);
  assert.equal(ui.document.getElementById('ops-nav').hidden, true);
  assert.equal(ui.document.getElementById('ops-updated').textContent, '');
});

for (const outcome of ['success', 'error']) test('private ' + outcome + ' response identity mismatch clears the obsolete session', async t => {
  let identity = user(), reads = 0;
  const ui = mount(request => {
    if (request.path === '/api/account') return json({ profile: identity }, 200, identity.user_id);
    if (request.path === '/api/orders') {
      if (++reads === 2) {
        identity = user('driver', 'driver-b', 'Bruno Motorista');
        return outcome === 'success' ? json({ orders: [order('foreign-private-order')] }, 200, 'driver-b') : json({ error: 'Pedido não encontrado para a nova conta' }, 404, 'driver-b');
      }
      return json({ orders: [] }, 200, identity.user_id);
    }
    if (request.path === '/api/orders/queue') return json({ orders: [] }, 200, identity.user_id);
    assert.fail('Unexpected request ' + request.path);
  });
  t.after(() => ui.dom.window.close());
  await ready(ui);
  const displayed = [];
  const observer = new ui.window.MutationObserver(() => displayed.push(ui.document.body.textContent));
  observer.observe(ui.document.body, { subtree: true, childList: true, characterData: true });
  t.after(() => observer.disconnect());
  ui.tick();
  await until(() => ui.document.getElementById('ops-identity').textContent.includes('Bruno Motorista'), 'replacement identity');
  await ready(ui);
  assert.equal(displayed.some(text => text.includes('foreign-private-order')), false);
  assert.equal(ui.document.body.textContent.includes('Ana'), false);
});

test('submission rechecks identity before sending and does not create an order as another account', async t => {
  let identity = user();
  const ui = mount(request => commerceApi(request, identity));
  t.after(() => ui.dom.window.close());
  await ready(ui); await checkout(ui);
  ui.document.querySelector('[data-quantity=product-a]').value = '1';
  const form = fill(ui, '#commerce-form', { dropoffAddress: 'Rua Destino, 20', dropoffArea: 'Jardim', paymentSimulation: true });
  identity = user('client', 'client-b', 'Bruna Cliente');
  submit(ui, form);
  await until(() => ui.document.getElementById('ops-identity').textContent.includes('Bruna Cliente'), 'replacement account before submit');
  await ready(ui);
  assert.equal(ui.calls.some(call => call.options.method === 'POST'), false);
  assert.equal(ui.document.getElementById('commerce-form'), null);
});

test('a session race rejected by the server resets identity without showing a successful order', async t => {
  let identity = user();
  const ui = mount(request => {
    if (request.path === '/api/orders' && request.options.method === 'POST') {
      assert.equal(request.options.headers.get('X-Titoja-User'), 'client-a');
      identity = user('client', 'client-b', 'Bruna Cliente');
      return json({ code: 'SESSION_CHANGED', error: 'A conta mudou.' }, 409, 'client-b');
    }
    return commerceApi(request, identity);
  });
  t.after(() => ui.dom.window.close());
  await ready(ui); await checkout(ui);
  ui.document.querySelector('[data-quantity=product-a]').value = '1';
  submit(ui, fill(ui, '#commerce-form', { dropoffAddress: 'Rua Destino, 20', dropoffArea: 'Jardim', paymentSimulation: true }));
  await until(() => ui.document.getElementById('ops-identity').textContent.includes('Bruna Cliente'), 'session race recovery');
  await ready(ui);
  assert.equal(ui.document.getElementById('order-live'), null);
  assert.equal(ui.document.body.textContent.includes('Ana'), false);
});

for (const source of ['focus', 'pageshow', 'broadcast', 'visibility']) {
  test(source + ' rechecks the account and cannot restore an obsolete account response', async t => {
    const slow = deferred();
    let accounts = 0;
    const ui = mount(request => {
      if (request.path === '/api/account') return ++accounts === 3 ? slow.promise : json({ profile: user() });
      if (request.path === '/api/orders') return json({ orders: [order('private-a')] });
      if (request.path === '/api/auth/logout') return json({ ok: true });
      assert.fail('Unexpected request ' + request.path);
    });
    t.after(() => ui.dom.window.close());
    await ready(ui);
    if (source === 'broadcast') ui.sessionChanged();
    else if (source === 'visibility') { ui.visibility(true); ui.visibility(false); }
    else {
      const event = new ui.window.Event(source);
      if (source === 'pageshow') Object.defineProperty(event, 'persisted', { value: true });
      ui.window.dispatchEvent(event);
    }
    if (source === 'pageshow' || source === 'broadcast') {
      assert.equal(ui.document.body.textContent.includes('Ana'), false);
      assert.equal(ui.document.querySelector('[data-order=private-a]'), null);
      assert.equal(ui.document.getElementById('ops-store-nav').hidden, true);
    }
    // A newer session event invalidates even a transport which ignores AbortSignal.
    ui.sessionChanged();
    await ready(ui);
    ui.document.getElementById('ops-signout').click();
    await until(() => ui.document.body.textContent.includes('Entre na sua conta'), 'logout');
    slow.resolve(json({ profile: user('establishment', 'old-store', 'Nome antigo') }, 200, 'old-store'));
    await settle();
    assert.equal(ui.document.body.textContent.includes('Nome antigo'), false);
    assert.equal(ui.document.body.textContent.includes('Ana'), false);
    assert.equal(ui.document.getElementById('ops-signout').hidden, true);
  });
}

test('focus and visibility recheck the same account without losing a checkout or its pending GPS pin', async t => {
  let success;
  const ui = mount(commerceApi, { geolocation: { getCurrentPosition(done) { success = done; }, clearWatch() {} } });
  t.after(() => ui.dom.window.close());
  await ready(ui); await checkout(ui);
  const form = fill(ui, '#commerce-form', { dropoffAddress: 'Rua Digitada, 10', dropoffArea: 'Centro' });
  ui.document.querySelector('[data-quantity=product-a]').value = '3';
  ui.document.querySelector('[data-use-location=dropoff]').click();
  ui.visibility(true); ui.visibility(false);
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await settle();
  assert.equal(ui.document.getElementById('commerce-form'), form);
  assert.equal(form.elements.namedItem('dropoffAddress').value, 'Rua Digitada, 10');
  assert.equal(ui.document.querySelector('[data-quantity=product-a]').value, '3');
  success(sample());
  await until(() => ui.document.getElementById('pin-dropoff').textContent.includes('14 m'), 'pending GPS after focus');
  assert.equal(ui.document.getElementById('commerce-form'), form);
});

test('tracking sends only consented valid samples; logout clears GPS before ordered removal and session revocation', async t => {
  const sent = deferred();
  let gpsSuccess, gpsFailure;
  const cleared = [], writes = [];
  const identity = user('courier', 'courier-a', 'Caio Entregador');
  const active = order('active-a', { status: 'in_transit', canShareLocation: true, availableActions: ['complete'] });
  const ui = mount(request => {
    if (request.path === '/api/account') return json({ profile: identity }, 200, identity.user_id);
    if (request.path === '/api/orders') return json({ orders: [active] }, 200, identity.user_id);
    if (request.path === '/api/orders/queue') return json({ orders: [] }, 200, identity.user_id);
    if (request.path === '/api/orders/active-a') return json({ order: active }, 200, identity.user_id);
    if (request.path.endsWith('/location')) {
      writes.push(request.options.method);
      return request.options.method === 'POST' ? sent.promise : json({ ok: true }, 200, identity.user_id);
    }
    if (request.path === '/api/auth/logout') { writes.push('logout'); return json({ ok: true }, 200, identity.user_id); }
    assert.fail('Unexpected request ' + request.path);
  }, { geolocation: {
    watchPosition(success, fail, config) { gpsSuccess = success; gpsFailure = fail; assert.deepEqual(JSON.parse(JSON.stringify(config)), { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }); return 41; },
    clearWatch(id) { cleared.push(id); },
  } });
  t.after(() => ui.dom.window.close());
  await ready(ui); ui.document.querySelector('[data-order]').click();
  await until(() => ui.document.querySelector('[data-share-location]'), 'tracking controls');
  assert.equal(gpsSuccess, undefined);
  ui.document.querySelector('[data-share-location]').click();
  await until(() => gpsSuccess, 'GPS consent');
  gpsSuccess(sample({ timestamp: Date.now() - 180000 }));
  assert.match(ui.document.getElementById('ops-message').textContent, /inválida ou desatualizada/);
  assert.equal(writes.length, 0);
  gpsSuccess(sample());
  await until(() => writes.length === 1, 'GPS POST');
  const locationRequest = ui.calls.find(call => call.path.endsWith('/location'));
  assert.deepEqual(locationRequest.payload, { latitude: -10.5, longitude: -40.25, accuracy: 14 });
  assert.equal(locationRequest.options.headers.get('X-Titoja-User'), 'courier-a');
  ui.document.getElementById('ops-signout').click();
  await until(() => cleared.length, 'watch stopped');
  assert.deepEqual(cleared, [41]);
  assert.deepEqual(writes, ['POST']);
  gpsSuccess(sample()); gpsFailure({ code: 1 });
  sent.resolve(json({ ok: true }, 200, identity.user_id));
  await until(() => ui.document.body.textContent.includes('Entre na sua conta'), 'tracking logout');
  assert.deepEqual(writes, ['POST', 'DELETE', 'logout']);
  assert.equal(ui.document.body.textContent.includes('Caio'), false);
  assert.equal(ui.document.querySelector('[name=deliveryCode]'), null);
  assert.equal(ui.document.getElementById('ops-identity').textContent, 'Sua conta');
  assert.deepEqual(ui.channels[0].sent, [{ type: 'changed' }]);
  assert.equal(ui.storageAccesses(), 0);
});

for (const change of ['rejected-removal', 'broadcast-during-removal']) test('logout preserves the replacement session after ' + change, async t => {
  const removal = deferred();
  let identity = user('courier', 'courier-a', 'Caio Entregador'), success;
  const active = order('active-a', { status: 'assigned', canShareLocation: true });
  const ui = mount(request => {
    if (request.path === '/api/account') return json({ profile: identity }, 200, identity.user_id);
    if (request.path === '/api/orders') return json({ orders: identity.user_id === 'courier-a' ? [active] : [] }, 200, identity.user_id);
    if (request.path === '/api/orders/queue') return json({ orders: [] }, 200, identity.user_id);
    if (request.path === '/api/orders/active-a') return json({ order: active }, 200, identity.user_id);
    if (request.path.endsWith('/location')) return removal.promise;
    if (request.path === '/api/auth/logout') assert.fail('The replacement account must never be logged out');
    assert.fail('Unexpected request ' + request.path);
  }, { geolocation: { watchPosition(done) { success = done; return 85; }, clearWatch() {} } });
  t.after(() => ui.dom.window.close());
  await ready(ui); ui.document.querySelector('[data-order]').click();
  await until(() => ui.document.querySelector('[data-share-location]'), 'order');
  ui.document.querySelector('[data-share-location]').click(); await until(() => success, 'GPS started');
  ui.document.getElementById('ops-signout').click();
  await until(() => ui.calls.some(call => call.options.method === 'DELETE'), 'logout cleanup pending');
  identity = user('client', 'client-b', 'Bruna Cliente');
  if (change === 'broadcast-during-removal') ui.sessionChanged();
  removal.resolve(change === 'rejected-removal' ? json({ code: 'SESSION_CHANGED', error: 'A conta mudou' }, 409, 'client-b') : json({ ok: true }, 200, 'courier-a'));
  await until(() => ui.document.getElementById('ops-identity').textContent.includes('Bruna Cliente'), 'replacement session preserved');
  await ready(ui); await settle();
  assert.equal(ui.calls.some(call => call.path === '/api/auth/logout'), false);
  assert.equal(ui.channels[0].sent.length, 0);
  assert.equal(ui.document.getElementById('ops-signout').hidden, false);
  assert.equal(ui.document.body.textContent.includes('Caio'), false);
});

test('navigation stops tracking, removes its last sample and ignores subsequent GPS callbacks', async t => {
  let success;
  const cleared = [];
  const identity = user('driver', 'driver-a', 'Davi Motorista');
  const active = order('active-a', { service: 'moto', status: 'assigned', canShareLocation: true });
  const ui = mount(request => {
    if (request.path === '/api/account') return json({ profile: identity }, 200, identity.user_id);
    if (request.path === '/api/orders') return json({ orders: [active] }, 200, identity.user_id);
    if (request.path === '/api/orders/queue') return json({ orders: [] }, 200, identity.user_id);
    if (request.path === '/api/orders/active-a') return json({ order: active }, 200, identity.user_id);
    if (request.path.endsWith('/location')) return json({ ok: true }, 200, identity.user_id);
    assert.fail('Unexpected request ' + request.path);
  }, { geolocation: { watchPosition(done) { success = done; return 52; }, clearWatch(id) { cleared.push(id); } } });
  t.after(() => ui.dom.window.close());
  await ready(ui); ui.document.querySelector('[data-order]').click();
  await until(() => ui.document.querySelector('[data-share-location]'), 'order');
  ui.document.querySelector('[data-share-location]').click(); await until(() => success, 'GPS started');
  ui.document.querySelector('[data-nav=orders]').click(); await ready(ui);
  success(sample()); await settle();
  assert.deepEqual(cleared, [52]);
  assert.deepEqual(ui.calls.filter(call => call.path.endsWith('/location')).map(call => call.options.method), ['DELETE']);
  assert.equal(ui.document.querySelector('[data-stop-location]'), null);
});

for (const ending of ['denied', 'pagehide']) test(ending + ' stops tracking and removes the sample without sending further GPS readings', async t => {
  let success, reject;
  const cleared = [];
  const identity = user('driver', 'driver-a', 'Davi Motorista');
  const active = order('active-a', { service: 'car', status: 'assigned', canShareLocation: true });
  const ui = mount(request => {
    if (request.path === '/api/account') return json({ profile: identity }, 200, identity.user_id);
    if (request.path === '/api/orders') return json({ orders: [active] }, 200, identity.user_id);
    if (request.path === '/api/orders/queue') return json({ orders: [] }, 200, identity.user_id);
    if (request.path === '/api/orders/active-a') return json({ order: active }, 200, identity.user_id);
    if (request.path.endsWith('/location')) return json({ ok: true }, 200, identity.user_id);
    assert.fail('Unexpected request ' + request.path);
  }, { geolocation: { watchPosition(done, fail) { success = done; reject = fail; return 74; }, clearWatch(id) { cleared.push(id); } } });
  t.after(() => ui.dom.window.close());
  await ready(ui); ui.document.querySelector('[data-order]').click();
  await until(() => ui.document.querySelector('[data-share-location]'), 'order');
  ui.document.querySelector('[data-share-location]').click(); await until(() => success, 'GPS started');
  if (ending === 'denied') reject({ code: 1 }); else ui.window.dispatchEvent(new ui.window.Event('pagehide'));
  await until(() => ui.calls.some(call => call.path.endsWith('/location')), 'sample removal');
  success(sample()); await settle();
  const requests = ui.calls.filter(call => call.path.endsWith('/location'));
  assert.deepEqual(cleared, [74]);
  assert.deepEqual(requests.map(call => call.options.method), ['DELETE']);
  assert.equal(requests[0].options.keepalive, ending === 'pagehide');
  assert.equal(requests[0].options.headers.get('X-Titoja-User'), 'driver-a');
  if (ending === 'denied') {
    assert.match(ui.document.getElementById('ops-message').textContent, /Permissão de localização negada/);
    assert.ok(ui.document.querySelector('[data-share-location]'));
  } else assert.equal(ui.intervals.size, 0);
});

test('polling preserves a typed completion code but a permission change stops GPS and removes its sample', async t => {
  let active = order('active-a', { status: 'in_transit', canShareLocation: true, availableActions: ['complete'] });
  let success;
  const cleared = [];
  const identity = user('courier', 'courier-a', 'Caio Entregador');
  const ui = mount(request => {
    if (request.path === '/api/account') return json({ profile: identity }, 200, identity.user_id);
    if (request.path === '/api/orders') return json({ orders: [active] }, 200, identity.user_id);
    if (request.path === '/api/orders/queue') return json({ orders: [] }, 200, identity.user_id);
    if (request.path === '/api/orders/active-a') return json({ order: active }, 200, identity.user_id);
    if (request.path.endsWith('/location')) return json({ ok: true }, 200, identity.user_id);
    assert.fail('Unexpected request ' + request.path);
  }, { geolocation: { watchPosition(done) { success = done; return 63; }, clearWatch(id) { cleared.push(id); } } });
  t.after(() => ui.dom.window.close());
  await ready(ui); ui.document.querySelector('[data-order]').click();
  await until(() => ui.document.querySelector('[name=deliveryCode]'), 'completion input');
  const originalInput = ui.document.querySelector('[name=deliveryCode]');
  originalInput.value = '123456'; originalInput.focus();
  ui.tick();
  await until(() => ui.document.querySelector('[name=deliveryCode]') !== originalInput, 'order poll');
  assert.equal(ui.document.querySelector('[name=deliveryCode]').value, '123456');
  assert.equal(ui.document.activeElement, ui.document.querySelector('[name=deliveryCode]'));
  ui.document.querySelector('[data-share-location]').click(); await until(() => success, 'GPS started');
  active = { ...active, status: 'completed', canShareLocation: false, availableActions: [] };
  ui.tick();
  await until(() => ui.document.querySelector('#order-live .ops-status')?.textContent === 'Concluído', 'completed order');
  assert.deepEqual(cleared, [63]);
  assert.equal(ui.calls.filter(call => call.path.endsWith('/location') && call.options.method === 'DELETE').length, 1);
  assert.equal(ui.document.querySelector('[name=deliveryCode]'), null);
  assert.equal(ui.document.querySelector('[data-share-location], [data-stop-location]'), null);
});

test('map remains optional and its late controller cannot draw on a later view', async t => {
  const mounted = deferred();
  const ui = mount(request => request.path === '/api/map-config' ? json({ tileUrl: 'https://tiles.invalid/{z}/{x}/{y}.png' }, 200, null) : commerceApi(request), {
    mountMap(container, config, instance) { return mounted.promise.then(() => instance); },
  });
  t.after(() => ui.dom.window.close());
  await ready(ui); ui.document.querySelector('[data-service=delivery]').click();
  await until(() => ui.document.getElementById('order-form'), 'direct form');
  fill(ui, '#order-form', { pickupAddress: 'Endereço digitado de origem' });
  ui.document.querySelector('[data-open-map]').click();
  await until(() => ui.mapCalls.length === 1, 'explicit map load');
  const oldMap = ui.mapCalls[0];
  ui.document.querySelector('[data-nav=home]').click(); await ready(ui);
  mounted.resolve(); await settle();
  oldMap.config.onPick({ lat: 1, lng: 2 });
  ui.document.querySelector('[data-service=delivery]').click();
  await until(() => ui.document.getElementById('order-form'), 'another form');
  assert.match(ui.document.getElementById('pin-pickup').textContent, /sem coordenadas/);
  assert.equal(ui.calls.filter(call => call.path === '/api/map-config').length, 1);
});
