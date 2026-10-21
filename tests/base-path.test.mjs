import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../dist/server/app.js';

test('base paths reject ambiguous segments and keep the default root available', async () => {
  const config = { databasePath: ':memory:', origin: 'http://127.0.0.1' };
  for (const basePath of ['/', 'titoja', '/titoja/', '//other', '/a//b', '/.', '/..', '/a/../b', '/a.b', '/a?x', '/a#x', '/%74itoja', '/a\\b', '/a\n', '/' + 'a'.repeat(160), 123]) {
    assert.throws(() => createApp({ ...config, basePath }), /BASE_PATH/, `reject ${JSON.stringify(basePath)}`);
  }
  for (const basePath of ['', '/titoja', '/apps/titoja-v2']) {
    const app = createApp({ ...config, basePath });
    await app.close();
  }
});

test('mounted HTML, APIs, demo and assets stay inside the configured prefix with correct HEAD lengths', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'titoja-base-path-'));
  const origin = 'http://127.0.0.1';
  const app = createApp({ databasePath: join(directory, 'mounted.sqlite'), origin, basePath: '/titoja' });
  await new Promise(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
  const address = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie } = {}) => fetch(address + path, {
    method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  try {
    for (const path of ['/titoja', '/titoja?from=link']) {
      const response = await request(path);
      assert.equal(response.status, 308);
      assert.equal(response.headers.get('location'), '/titoja/' + (path.includes('?') ? '?from=link' : ''));
    }
    for (const path of ['/', '/health', '/api/account', '/account.js', '/app/', '/demo/', '/titoja-other/', '/titoja-other/api/account']) {
      assert.equal((await request(path)).status, 404, `unmounted ${path}`);
    }
    assert.deepEqual(await (await request('/titoja/health')).json(), { status: 'ok' });
    assert.equal((await request('/titoja/api/account')).status, 401);
    assert.deepEqual(await (await request('/titoja/api/stores')).json(), { stores: [] });
    const demoRedirect = await request('/titoja/demo');
    assert.equal(demoRedirect.status, 308);
    assert.equal(demoRedirect.headers.get('location'), '/titoja/demo/');
    for (const path of ['/titoja/', '/titoja/app/', '/titoja/demo/']) {
      const response = await request(path);
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.match(html, /<meta name="titoja-base-path" content="\/titoja">/);
      assert.match(html, new RegExp(`<base href="${path.endsWith('/demo/') ? '/titoja/demo/' : '/titoja/'}">`));
      assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(html));
      assert.match(response.headers.get('content-security-policy'), /base-uri 'self'/);
      const head = await request(path, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
      assert.equal(await head.text(), '');
    }
    for (const path of ['/account.js', '/account.css', '/operations.js', '/operations.css', '/map.js', '/map.css', '/paths.js', '/vendor/leaflet.js', '/vendor/leaflet.css', '/vendor/images/marker-icon.png', '/assets/beer-3d.png', '/demo/app.js', '/demo/style.css', '/demo/assets/reference.png']) {
      const response = await request('/titoja' + path);
      assert.equal(response.status, 200, `mounted asset ${path}`);
      const bytes = await response.arrayBuffer();
      assert.equal(Number(response.headers.get('content-length')), bytes.byteLength);
    }
    for (const path of ['/titoja/%2e%2e/api/account', '/titoja/demo/%2e%2e%2f%2e%2e%2fpackage.json', '/titoja/assets/%2e%2e%2f%2e%2e%2fserver/app.ts', '/titoja/assets/%5c..%5cserver%5capp.ts', '/titoja/.env', '/titoja/data/mounted.sqlite', '/titoja/%2fapi/account', '/titoja/%252e%252e/api/account']) {
      assert.equal((await request(path)).status, 404, `blocked ${path}`);
    }
    assert.equal((await request('/titoja/%ZZ')).status, 400);
    const registered = await request('/titoja/api/auth/register', { method: 'POST', body: { name: 'Synthetic mounted account', email: 'synthetic-mounted@example.test', password: 'Synthetic mounted account passphrase', role: 'client' } });
    assert.equal(registered.status, 201);
    const account = await registered.json();
    const cookieHeader = registered.headers.get('set-cookie');
    assert.match(cookieHeader, /; Path=\//);
    assert.doesNotMatch(cookieHeader, /Path=\/titoja/);
    const current = await request('/titoja/api/account', { cookie: cookieHeader.split(';')[0] });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).profile.user_id, account.profile.user_id);
    assert.equal(current.headers.get('x-titoja-user'), account.profile.user_id);
  } finally {
    await app.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
