import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = resolve(root, 'node_modules/typescript/bin/tsc');
mkdirSync(resolve(root, 'public/vendor'), { recursive: true });
for (const [source, destination] of [
  ['dist/leaflet-src.esm.js', 'leaflet.js'],
  ['dist/leaflet.css', 'leaflet.css'],
  ['LICENSE', 'leaflet.LICENSE']
]) cpSync(resolve(root, 'node_modules/leaflet', source), resolve(root, 'public/vendor', destination));
cpSync(resolve(root, 'node_modules/leaflet/dist/images'), resolve(root, 'public/vendor/images'), { recursive: true });
mkdirSync(resolve(root, 'frontend/dist'), { recursive: true });
cpSync(resolve(root, 'frontend/static'), resolve(root, 'frontend/dist'), { recursive: true });
for (const project of ['frontend/tsconfig.json', 'client/tsconfig.json', 'server/tsconfig.json']) {
  execFileSync(process.execPath, [compiler, '-p', project], { cwd: root, stdio: 'inherit' });
}
for (const script of ['public/account.js', 'public/operations.js', 'frontend/dist/app.js', 'dist/server/index.js']) {
  execFileSync(process.execPath, ['--check', script], { cwd: root, stdio: 'inherit' });
}
for (const asset of ['reference.png', 'beer-3d.png', 'delivery-scooter.png']) {
  if (!existsSync(resolve(root, 'frontend/dist/assets', asset))) throw new Error(`Missing demo asset: ${asset}`);
}
const html = readFileSync(resolve(root, 'frontend/dist/index.html'), 'utf8');
if (!html.includes('lang="pt-BR"') || !html.includes('demo-notice')) throw new Error('Demo must retain locale and simulation notice');
console.log('Frontend and backend builds passed. Static assets and simulation notice verified.');
