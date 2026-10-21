import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { backupDatabase } from '../scripts/backup.mjs';
import { createApp } from '../dist/server/app.js';
import { openDatabase } from '../dist/server/database.js';

test('online backup includes committed WAL data, passes integrity and refuses overwrite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'titoja-backup-'));
  const source = join(directory, 'source.sqlite');
  const destination = join(directory, 'snapshot.sqlite');
  const writer = new DatabaseSync(source);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;');
    writer.prepare('INSERT INTO records(value) VALUES (?)').run('synthetic committed record');
    assert.ok(existsSync(source + '-wal'));
    const result = await backupDatabase(source, destination);
    assert.match(result.sqliteVersion, /^\d+\.\d+\.\d+$/);
    const reader = new DatabaseSync(destination, { readOnly: true });
    try { assert.equal(reader.prepare('SELECT value FROM records').get().value, 'synthetic committed record'); }
    finally { reader.close(); }
    writer.prepare('INSERT INTO records(value) VALUES (?)').run('newer source record');
    await assert.rejects(backupDatabase(source, destination), /new file/);
    const unchanged = new DatabaseSync(destination, { readOnly: true });
    try { assert.equal(unchanged.prepare('SELECT count(*) AS count FROM records').get().count, 1); }
    finally { unchanged.close(); }
    await assert.rejects(backupDatabase(source, resolve('public/forbidden-backup.sqlite')), /public directory/);
    assert.equal(existsSync(resolve('public/forbidden-backup.sqlite')), false);
    await assert.rejects(backupDatabase(join(directory, 'absent.sqlite'), join(directory, 'not-created.sqlite')), /does not exist/);
    assert.equal(existsSync(join(directory, 'absent.sqlite')), false);
  } finally {
    writer.close();
    // directory was created by this test under the user's temporary directory.
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a separate restored application preserves accounts and orders after online backup and revokes restored sessions before reopening', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'titoja-restore-'));
  const sourcePath = join(directory, 'active.sqlite');
  const restoredPath = join(directory, 'recovery', 'restored.sqlite');
  const origin = 'http://127.0.0.1';
  const config = { origin, authRateLimit: { windowMs: 60000, maxAttempts: 100 } };
  const sourceApp = createApp({ ...config, databasePath: sourcePath });
  let restoredDatabase;
  let restoredApp;
  const listen = async app => {
    await new Promise(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
    return `http://127.0.0.1:${app.server.address().port}`;
  };
  const request = async (base, path, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const credentials = role => ({ email: `synthetic-restore-${role}@example.test`, password: `Synthetic restore passphrase ${randomUUID()}` });
  const customerCredentials = credentials('customer');
  const courierCredentials = credentials('courier');
  try {
    const sourceBase = await listen(sourceApp);
    sourceApp.database.exec('PRAGMA wal_autocheckpoint=0');
    const customer = await request(sourceBase, '/api/auth/register', { method: 'POST', body: { ...customerCredentials, name: 'Synthetic restored customer', role: 'client' } });
    const courier = await request(sourceBase, '/api/auth/register', { method: 'POST', body: { ...courierCredentials, name: 'Synthetic restored courier', role: 'courier' } });
    assert.equal(customer.status, 201);
    assert.equal(courier.status, 201);
    const payload = { service: 'delivery', deliveryType: 'Synthetic document', requestId: randomUUID(), pickupAddress: 'Synthetic collection address 100', pickupArea: 'Synthetic origin district', dropoffAddress: 'Synthetic destination address 200', dropoffArea: 'Synthetic destination district' };
    const created = await request(sourceBase, '/api/orders', { cookie: customer.cookie, method: 'POST', body: payload });
    assert.equal(created.status, 201);
    const assigned = await request(sourceBase, `/api/orders/${created.data.order.id}/accept`, { cookie: courier.cookie, method: 'POST', body: { expectedVersion: 1 } });
    assert.equal(assigned.status, 200);
    const snapshotOrder = assigned.data.order;
    const migrations = sourceApp.database.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    assert.ok(migrations.length >= 3);
    assert.ok(existsSync(sourcePath + '-wal'), 'The live application has committed WAL data');
    const result = await backupDatabase(sourcePath, restoredPath);
    assert.equal(result.destination, resolve(restoredPath));

    // A backup is a point in time. Later source writes must not enter the restored copy.
    assert.equal((await request(sourceBase, '/api/orders', { cookie: customer.cookie, method: 'POST', body: { ...payload, requestId: randomUUID() } })).status, 201);
    await sourceApp.close();
    restoredDatabase = openDatabase(restoredPath);
    assert.equal(restoredDatabase.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(restoredDatabase.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(restoredDatabase.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all(), migrations);
    assert.equal(restoredDatabase.prepare('SELECT count(*) AS n FROM titoja_users').get().n, 2);
    assert.equal(restoredDatabase.prepare('SELECT count(*) AS n FROM titoja_profiles').get().n, 2);
    assert.equal(restoredDatabase.prepare('SELECT count(*) AS n FROM titoja_orders').get().n, 1);
    assert.equal(restoredDatabase.prepare('SELECT count(*) AS n FROM titoja_order_events').get().n, 2);
    assert.equal(restoredDatabase.prepare('SELECT worker_id FROM titoja_orders WHERE id = ?').get(snapshotOrder.id).worker_id, courier.data.profile.user_id);
    assert.equal(restoredDatabase.prepare('SELECT count(*) AS n FROM titoja_sessions').get().n, 2, 'Online backups include the sessions from that instant');
    // Follow the documented offline recovery step before starting the restored server.
    assert.equal(Number(restoredDatabase.prepare('DELETE FROM titoja_sessions').run().changes), 2);
    assert.equal(restoredDatabase.prepare('SELECT count(*) AS n FROM titoja_sessions').get().n, 0);
    restoredDatabase.close();
    restoredDatabase = undefined;

    restoredApp = createApp({ ...config, databasePath: restoredPath });
    const restoredBase = await listen(restoredApp);
    for (const account of [customer, courier]) {
      assert.equal((await request(restoredBase, '/api/account', { cookie: account.cookie })).status, 401, 'No pre-backup bearer session is valid after restoration');
      assert.equal((await request(restoredBase, `/api/orders/${snapshotOrder.id}`, { cookie: account.cookie })).status, 401);
    }
    const customerLogin = await request(restoredBase, '/api/auth/login', { method: 'POST', body: customerCredentials });
    const courierLogin = await request(restoredBase, '/api/auth/login', { method: 'POST', body: courierCredentials });
    assert.equal(customerLogin.status, 200);
    assert.equal(courierLogin.status, 200);
    assert.equal(customerLogin.data.profile.user_id, customer.data.profile.user_id);
    assert.equal(courierLogin.data.profile.user_id, courier.data.profile.user_id);
    assert.notEqual(customerLogin.cookie, customer.cookie);
    for (const account of [customerLogin, courierLogin]) {
      const recovered = await request(restoredBase, `/api/orders/${snapshotOrder.id}`, { cookie: account.cookie });
      assert.equal(recovered.status, 200);
      assert.equal(recovered.data.order.id, snapshotOrder.id);
      assert.equal(recovered.data.order.status, 'assigned');
      assert.equal(recovered.data.order.version, snapshotOrder.version);
      assert.deepEqual(recovered.data.order.history, snapshotOrder.history);
      assert.equal(recovered.data.order.paymentStatus, 'simulated');
    }
    const resumed = await request(restoredBase, `/api/orders/${snapshotOrder.id}/transition`, { cookie: courierLogin.cookie, method: 'POST', body: { action: 'goPickup', expectedVersion: snapshotOrder.version } });
    assert.equal(resumed.status, 200, 'The restored application can continue the persisted operation');
    assert.equal(resumed.data.order.status, 'heading_to_pickup');
    const originalDatabase = openDatabase(sourcePath);
    try {
      assert.equal(originalDatabase.prepare('SELECT count(*) AS n FROM titoja_orders').get().n, 2);
      assert.equal(originalDatabase.prepare('SELECT status FROM titoja_orders WHERE id = ?').get(snapshotOrder.id).status, 'assigned', 'Restored writes do not alter the source database');
      assert.equal(originalDatabase.prepare('SELECT count(*) AS n FROM titoja_sessions').get().n, 2, 'Invalidation was confined to the restored copy');
    } finally { originalDatabase.close(); }
  } finally {
    restoredDatabase?.close();
    await restoredApp?.close();
    await sourceApp.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
    rmSync(directory, { recursive: true, force: true });
  }
});
