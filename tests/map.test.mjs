import assert from 'node:assert/strict';
import test from 'node:test';

async function withGlobals(values, run) {
  const previous = new Map(Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, {configurable: true, value});
    return await run();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

let map;

test('map module import is inert until an explicit map or location request', async () => {
  const names = ['document', 'window', 'navigator', 'Image'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let networkRequests = 0;
  try {
    for (const name of names) Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { throw new Error(`Map import accessed ${name} before user action`); },
    });
    await withGlobals({fetch() {networkRequests++; throw new Error('Network is forbidden in map tests');}}, async () => {
      // No Leaflet engine is imported, and no DOM, geolocation or external tile request occurs here.
      map = await import('../public/map.js');
    });
    assert.equal(networkRequests, 0);
    assert.equal(typeof map.mountMap, 'function');
    assert.equal(typeof map.getCurrentPosition, 'function');
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('map coordinates accept only finite numeric latitude and longitude in geographic bounds', () => {
  for (const point of [{lat: 0, lng: 0}, {lat: -90, lng: -180}, {lat: 90, lng: 180}]) {
    assert.equal(map.isMapPoint(point), true);
  }
  for (const point of [null, undefined, {}, {lat: 1}, {lat: '1', lng: 2}, {lat: NaN, lng: 2},
    {lat: Infinity, lng: 2}, {lat: 91, lng: 2}, {lat: 1, lng: -181}]) {
    assert.equal(map.isMapPoint(point), false);
  }
});

test('application resource paths use a validated mount prefix for API, Leaflet and marker assets', async () => {
  const { appPath } = await import('../public/paths.js');
  const document = content => ({ querySelector(selector) { assert.equal(selector, 'meta[name="titoja-base-path"]'); return content === null ? null : { content }; } });
  for (const path of ['/api/account', '/api/orders?limit=10', '/vendor/leaflet.js', '/vendor/leaflet.css', '/vendor/images/marker-icon.png', '/vendor/images/marker-shadow.png', '/app/', '/']) {
    assert.equal(appPath(path, document('')), path);
    assert.equal(appPath(path, document(null)), path);
    assert.equal(appPath(path, document('/titoja')), '/titoja' + path);
    assert.equal(appPath(path, document('/apps/titoja-2')), '/apps/titoja-2' + path);
  }
  for (const prefix of ['/', '/titoja/', '//external.invalid', 'https://external.invalid', '/a/../b', '/a%2fb', '/a?x=1', '/a#b', '/a\\b', '/a"x', '/' + 'a'.repeat(160)]) {
    assert.throws(() => appPath('/api/account', document(prefix)), /configurado incorretamente/);
  }
  for (const path of ['https://external.invalid/', '//external.invalid/', 'api/account', '/a/../api', '/a/./api', '/a\\api', '/a\napi']) {
    assert.throws(() => appPath(path, document('/titoja')), /caminho do aplicativo é inválido/);
  }
});

test('tile configuration requires HTTPS templates and rejects URL credentials or unknown placeholders', () => {
  assert.equal(map.validateTileUrl(map.DEFAULT_TILE_URL), 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(map.validateTileUrl('https://maps.example.invalid/{z}/{x}/{y}.png'), 'https://maps.example.invalid/{z}/{x}/{y}.png');
  for (const template of [null, '', 'http://tile.openstreetmap.org/{z}/{x}/{y}.png',
    'https://example:example@maps.example.invalid/{z}/{x}/{y}.png',
    'javascript:alert(1)', 'https://maps.example.invalid/map.png',
    'https://maps.example.invalid/{other}/{z}/{x}/{y}.png',
    'https://maps.example.invalid/{z}/{x}/{y}.png#fragment']) {
    assert.throws(() => map.validateTileUrl(template));
  }
});

test('invalid map point is rejected before loading Leaflet, styles or tiles', async () => {
  const container = {ownerDocument: {}};
  await assert.rejects(map.mountMap(container, {initialPoint: {lat: 91, lng: 2}}), /Coordenadas inválidas/);
});

test('geolocation unsupported and insecure paths do not invoke a device provider', async () => {
  await withGlobals({navigator: {}}, async () => {
    await assert.rejects(map.getCurrentPosition(), error => error instanceof map.LocationError && error.code === 'unsupported');
  });
  let calls = 0;
  await withGlobals({isSecureContext: false, navigator: {geolocation: {getCurrentPosition() {calls++;}}}}, async () => {
    await assert.rejects(map.getCurrentPosition(), error => error.code === 'insecure');
  });
  assert.equal(calls, 0);
});

test('geolocation distinguishes denied, unavailable and timed out requests using only stubs', async () => {
  for (const [nativeCode, code] of [[1, 'denied'], [2, 'unavailable'], [3, 'timeout']]) {
    let calls = 0;
    await withGlobals({isSecureContext: true, navigator: {geolocation: {
      getCurrentPosition(success, failure, options) {
        calls++;
        assert.deepEqual(options, {enableHighAccuracy: true, timeout: 15000, maximumAge: 0});
        failure({code: nativeCode});
      },
    }}}, async () => {
      assert.equal(calls, 0);
      await assert.rejects(map.getCurrentPosition(), error => error.code === code);
      assert.equal(calls, 1);
    });
  }
});

test('geolocation returns the actual stub coordinate with accuracy and sample time without sending it anywhere', async () => {
  const timestamp = Date.now();
  let networkRequests = 0;
  const original = {coords: {latitude: 1, longitude: 2, accuracy: 250}, timestamp};
  await withGlobals({isSecureContext: true, fetch() {networkRequests++; throw new Error('No GPS transmission allowed');},
    navigator: {geolocation: {getCurrentPosition(success, failure, options) {
      assert.deepEqual(options, {enableHighAccuracy: false, timeout: 5000, maximumAge: 0});
      success(original);
    }}}}, async () => {
    assert.deepEqual(await map.getCurrentPosition({enableHighAccuracy: false, timeout: 5000}), {
      point: {lat: 1, lng: 2}, accuracy: 250, timestamp,
    });
    assert.equal(networkRequests, 0);
  });
});

test('geolocation rejects invalid coordinates, missing timestamps and negative or missing accuracy', async () => {
  const good = {latitude: 1, longitude: 2, accuracy: 5};
  for (const sample of [
    {coords: {...good, latitude: 91}, timestamp: Date.now()},
    {coords: {...good, longitude: NaN}, timestamp: Date.now()},
    {coords: {...good, accuracy: -1}, timestamp: Date.now()},
    {coords: {latitude: 1, longitude: 2}, timestamp: Date.now()},
    {coords: good},
    {coords: good, timestamp: 0},
  ]) {
    await withGlobals({isSecureContext: true, navigator: {geolocation: {getCurrentPosition(success) {success(sample);}}}}, async () => {
      await assert.rejects(map.getCurrentPosition(), error => error.code === 'invalid');
    });
  }
});

test('geolocation rejects stale samples and samples implausibly ahead of the device clock', async () => {
  for (const timestamp of [Date.now() - 60000, Date.now() + 600000]) {
    await withGlobals({isSecureContext: true, navigator: {geolocation: {
      getCurrentPosition(success) {success({coords: {latitude: 1, longitude: 2, accuracy: 5}, timestamp});},
    }}}, async () => {
      await assert.rejects(map.getCurrentPosition(), error => error.code === 'stale');
    });
  }
});
