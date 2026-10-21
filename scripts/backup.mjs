import { DatabaseSync, backup } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
export async function backupDatabase(sourcePath, destinationPath) {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error('Source database does not exist');
  if (source === destination || existsSync(destination)) throw new Error('Backup destination must be a new file');
  for (const directory of ['public', 'frontend/dist', 'frontend/static']) {
    const inside = relative(resolve(project, directory), destination);
    if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`))) {
      throw new Error('Do not store backups in a public directory');
    }
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const sourceDb = new DatabaseSync(source, { readOnly: true, timeout: 5000, allowExtension: false });
  let reserved = false;
  try {
    const descriptor = openSync(destination, 'wx', 0o600);
    reserved = true;
    closeSync(descriptor);
    await backup(sourceDb, destination);
    const snapshot = new DatabaseSync(destination, { readOnly: true, allowExtension: false });
    let sqliteVersion;
    try {
      if (snapshot.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Backup integrity check failed');
      if (snapshot.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup foreign-key check failed');
      sqliteVersion = snapshot.prepare('SELECT sqlite_version() AS version').get().version;
    } finally { snapshot.close(); }
    return { destination, sqliteVersion };
  } catch (error) {
    if (reserved) { try { unlinkSync(destination); } catch {} }
    throw error;
  } finally { sourceDb.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const destination = process.argv[2];
  if (!destination || process.argv.length !== 3) {
    console.error('Usage: npm run db:backup -- <new-backup-file>');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await backupDatabase(process.env.DATABASE_PATH || './data/titoja.sqlite', destination))); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Backup failed'); process.exitCode = 1; }
  }
}
