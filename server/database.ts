import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));
export const minimumSqliteVersion = '3.50.4';

export function supportedSqliteVersion(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const current = version.split('.').map(Number);
  const minimum = minimumSqliteVersion.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

export function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true, mode: 0o700 });
    try {
      // Reserve a NEW file atomically with restrictive POSIX permissions.
      // Existing files retain their current permissions.
      closeSync(openSync(databasePath, 'wx', 0o600));
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  const database = new DatabaseSync(databasePath);
  try {
    const version = String(database.prepare('SELECT sqlite_version() AS version').get()?.version);
    if (!supportedSqliteVersion(version)) throw new Error('SQLite ' + minimumSqliteVersion + ' or newer is required; upgrade Node.js');
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const migrations = readdirSync(migrationsDirectory).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (migrations.length === 0) throw new Error('No database migrations found');
    const knownVersions = new Set(migrations.map(name => Number(name.slice(0, 4))));
    for (const applied of database.prepare('SELECT version FROM schema_migrations').all()) {
      if (!knownVersions.has(Number(applied.version))) throw new Error('Database schema is newer than this application');
    }
    transaction(database, () => {
      for (const name of migrations) {
        const version = Number(name.slice(0, 4));
        const sql = readFileSync(resolve(migrationsDirectory, name), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const applied = database.prepare('SELECT name, checksum FROM schema_migrations WHERE version = ?').get(version);
        if (applied) {
          if (applied.name !== name || applied.checksum !== checksum) throw new Error('An applied migration was modified: ' + name);
          continue;
        }
        database.exec(sql);
        database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(version, name, checksum, new Date().toISOString());
      }
    });
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
