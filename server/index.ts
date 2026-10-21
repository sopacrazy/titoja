import { resolve } from 'node:path';
import { createApp } from './app.js';

const production = process.env.NODE_ENV === 'production';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '4173');
const origin = process.env.APP_ORIGIN ?? (production ? '' : 'http://127.0.0.1:' + port);
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('HOST must be a loopback address');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
if (production && !origin.startsWith('https://')) throw new Error('Production requires an explicit HTTPS APP_ORIGIN');
if (process.platform !== 'win32') process.umask(0o077);

const app = createApp({
  databasePath: resolve(process.env.DATABASE_PATH ?? 'data/titoja.sqlite'),
  origin,
  secureCookies: production || origin.startsWith('https://'),
  ...(process.env.MAP_TILE_URL ? { mapTileUrl: process.env.MAP_TILE_URL } : {}),
  trustLoopbackProxy: process.env.TRUST_LOOPBACK_PROXY === 'true',
});
app.server.on('error', () => {
  console.error('Não foi possível iniciar o servidor na porta configurada');
  void app.close().finally(() => { process.exitCode = 1; });
});
app.server.listen(port, host, () => {
  console.log('TitoJá disponível em ' + origin + ' (servidor local em ' + host + ':' + port + ')');
  console.log('SQLite embarcado: ' + app.sqliteVersion);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().finally(() => { process.exitCode = 0; }); });
}
