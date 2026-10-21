import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['tests', 'frontend/tests'].flatMap(directory => readdirSync(resolve(root, directory))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => resolve(root, directory, name)));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TITOJA_JSDOM_PATH: pathToFileURL(resolve(root, 'node_modules/jsdom/lib/api.js')).href }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
