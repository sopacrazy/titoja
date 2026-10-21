import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from './database.js';
import { hashPassword, newSessionToken, RateLimiter, sessionHash, verifyPassword } from './security.js';
import { CatalogService, CatalogError } from './catalog.js';
import { OrderService, OrderError } from './orders.js';

const roles = ['client', 'courier', 'establishment', 'driver'] as const;
export type Role = typeof roles[number];
export type Profile = { user_id: string; role: Role; name: string; establishment_name: string | null; created_at: string };
export type Account = { profile: Profile; identity: { name: string; email: string } };
type AuthenticatedRow = Profile & { email: string };
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const maxBodyBytes = 4096;
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

export interface AppConfig {
  databasePath: string;
  origin: string;
  secureCookies?: boolean;
  publicDirectory?: string;
  demoDirectory?: string;
  sessionTtlMs?: number;
  now?: () => number;
  authRateLimit?: { windowMs: number; maxAttempts: number };
  maxConcurrentPasswordChecks?: number;
  mapTileUrl?: string;
  trustLoopbackProxy?: boolean;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number, readonly code?: string) { super(message); }
}

function json(response: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'Vary': 'Cookie',
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Envie um objeto JSON válido');
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, 'Campo não permitido');
}

function emailAddress(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Informe um e-mail válido');
  const email = value.trim().toLowerCase();
  const split = email.split('@');
  const local = split[0] ?? '';
  const domain = split[1] ?? '';
  const labels = domain.split('.');
  if (email.length > 254 || split.length !== 2 || local.length < 1 || local.length > 64 ||
      !/^[a-z0-9.!#$%&'*+/=?^_{}|~\x60-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      labels.length < 2 || labels.some(label => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
      !/^[a-z]{2,63}$/.test(labels.at(-1) ?? '')) throw new HttpError(400, 'Informe um e-mail válido');
  return email;
}

function passwordValue(value: unknown): string {
  if (typeof value !== 'string' || Array.from(value).length < 15 || value.length > 128) throw new HttpError(400, 'Use uma senha de 15 a 128 caracteres');
  return value;
}

function displayName(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || Array.from(value.trim()).length < 2 || value.trim().length > maximum || /[\u0000-\u001f\u007f<>]/u.test(value)) {
    throw new HttpError(400, 'Informe ' + label + ' de 2 a ' + maximum + ' caracteres');
  }
  return value.trim();
}

function registration(value: Record<string, unknown>) {
  fields(value, ['email', 'password', 'name', 'role', 'establishmentName']);
  if (!roles.includes(value.role as Role)) throw new HttpError(400, 'Escolha um perfil válido');
  const role = value.role as Role;
  const establishmentName = role === 'establishment'
    ? displayName(value.establishmentName, 100, 'o nome do estabelecimento')
    : null;
  if (role !== 'establishment' && value.establishmentName !== undefined && value.establishmentName !== '') throw new HttpError(400, 'Este perfil não possui estabelecimento');
  return { email: emailAddress(value.email), password: passwordValue(value.password), name: displayName(value.name, 80, 'um nome'), role, establishmentName };
}

function readBody(request: IncomingMessage, limit = maxBodyBytes): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let bytes = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > limit) {
        rejected = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Dados muito longos'));
      } else chunks.push(chunk);
    });
    request.once('end', () => {
      if (rejected) return;
      try { resolveBody(requireObject(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch (error) { reject(error instanceof HttpError ? error : new HttpError(400, 'JSON inválido')); }
    });
    request.once('aborted', () => reject(new HttpError(400, 'Envio interrompido')));
    request.once('error', () => reject(new HttpError(400, 'Envio inválido')));
  });
}

function tokenFromCookie(request: IncomingMessage, cookieName: string): string | null {
  const matches = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(cookieName + '='));
  if (matches.length !== 1) return null;
  const token = matches[0]!.slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function profileForUser(database: DatabaseSync, userId: string): Account {
  const row = database.prepare('SELECT p.user_id, p.role, p.name, p.establishment_name, p.created_at, u.email FROM titoja_profiles p JOIN titoja_users u ON u.id = p.user_id WHERE p.user_id = ?').get(userId) as AuthenticatedRow | undefined;
  if (!row) throw new HttpError(401, 'Entre na sua conta para continuar');
  return { profile: { user_id: row.user_id, role: row.role, name: row.name, establishment_name: row.establishment_name, created_at: row.created_at }, identity: { name: row.name, email: row.email } };
}

export function createApp(config: AppConfig) {
  let originUrl: URL;
  try { originUrl = new URL(config.origin); } catch { throw new Error('APP_ORIGIN must be a valid HTTP(S) origin'); }
  if (originUrl.origin !== config.origin || !['http:', 'https:'].includes(originUrl.protocol)) throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path');
  if (originUrl.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname)) throw new Error('Plain HTTP is allowed only on loopback');
  const secure = config.secureCookies ?? originUrl.protocol === 'https:';
  if (originUrl.protocol === 'https:' && !secure) throw new Error('HTTPS requires Secure session cookies');
  const ttl = config.sessionTtlMs ?? sessionLifetime;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > sessionLifetime) throw new Error('Invalid session lifetime');
  const maxConcurrent = config.maxConcurrentPasswordChecks ?? 4;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) throw new Error('Invalid password concurrency limit');
  const rateConfig = config.authRateLimit ?? { windowMs: 15 * 60 * 1000, maxAttempts: 10 };
  if (!Number.isSafeInteger(rateConfig.windowMs) || rateConfig.windowMs < 1000 || !Number.isSafeInteger(rateConfig.maxAttempts) || rateConfig.maxAttempts < 1) throw new Error('Invalid rate limit');
  const now = config.now ?? Date.now;
  const mapTileUrl = config.mapTileUrl ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  let tileUrl: URL;
  try { tileUrl = new URL(mapTileUrl); } catch { throw new Error('MAP_TILE_URL must be a valid public HTTPS XYZ template'); }
  if (mapTileUrl.length > 2048 || tileUrl.protocol !== 'https:' || tileUrl.username || tileUrl.password || tileUrl.search || tileUrl.hash ||
      !['{z}', '{x}', '{y}'].every(part => mapTileUrl.includes(part)) || !/^[a-zA-Z0-9_./{}%-]+$/.test(tileUrl.pathname)) {
    throw new Error('MAP_TILE_URL must be a public HTTPS XYZ template without credentials, query parameters or a fragment');
  }
  const cookieName = secure ? '__Host-titoja_session' : 'titoja_session';
  const publicDirectory = config.publicDirectory ?? resolve(projectRoot, 'public');
  const demoDirectory = config.demoDirectory ?? resolve(projectRoot, 'frontend/dist');
  const database = openDatabase(config.databasePath);
  const catalog = new CatalogService(database, now);
  const orders = new OrderService(database, now);
  const limiter = new RateLimiter(rateConfig.windowMs, rateConfig.maxAttempts);
  let passwordChecks = 0;

  function sessionCookie(token: string): string {
    return cookieName + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(ttl / 1000) + (secure ? '; Secure' : '');
  }
  function clearedCookie(): string {
    return cookieName + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT' + (secure ? '; Secure' : '');
  }
  function authenticate(request: IncomingMessage, response: ServerResponse): Account {
    const token = tokenFromCookie(request, cookieName);
    if (!token) throw new HttpError(401, 'Entre na sua conta para continuar');
    const row = database.prepare('SELECT user_id FROM titoja_sessions WHERE token_hash = ? AND expires_at > ?').get(sessionHash(token), now());
    if (!row) throw new HttpError(401, 'Entre na sua conta para continuar');
    const account = profileForUser(database, String(row.user_id));
    response.setHeader('X-Titoja-User', account.profile.user_id);
    return account;
  }
  function guardSessionIdentity(request: IncomingMessage, account: Account): void {
    const expectedUser = request.headers['x-titoja-user'];
    // The browser pins its current account so a changed shared cookie cannot submit
    // an earlier tab's draft as the newly signed-in person. This is not identity proof.
    if (expectedUser !== undefined && expectedUser !== account.profile.user_id) {
      throw new HttpError(409, 'A conta mudou. Atualize a página antes de continuar', undefined, 'SESSION_CHANGED');
    }
  }
  function createSession(userId: string, request: IncomingMessage): string {
    const token = newSessionToken();
    const timestamp = now();
    const previous = tokenFromCookie(request, cookieName);
    if (previous) database.prepare('DELETE FROM titoja_sessions WHERE token_hash = ?').run(sessionHash(previous));
    database.prepare('DELETE FROM titoja_sessions WHERE expires_at <= ?').run(timestamp);
    database.prepare('INSERT INTO titoja_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sessionHash(token), userId, timestamp, timestamp + ttl);
    database.prepare('DELETE FROM titoja_sessions WHERE user_id = ? AND token_hash NOT IN (SELECT token_hash FROM titoja_sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5)').run(userId, userId);
    return token;
  }
  function guardMutation(request: IncomingMessage, limit = maxBodyBytes): void {
    if (request.headers.origin !== config.origin || request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Origem não autorizada');
    if ((request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Envie JSON');
    const contentLength = request.headers['content-length'];
    if (contentLength && Number(contentLength) > limit) { request.resume(); throw new HttpError(413, 'Dados muito longos'); }
  }
  async function passwordOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (passwordChecks >= maxConcurrent) throw new HttpError(503, 'Muitas tentativas simultâneas. Tente novamente', 1);
    passwordChecks += 1;
    try { return await operation(); } finally { passwordChecks -= 1; }
  }
  function rateLimit(request: IncomingMessage): void {
    const remoteAddress = request.socket.remoteAddress ?? 'unknown';
    let key = remoteAddress;
    // Opt-in for a loopback reverse proxy that OVERWRITES X-Forwarded-For.
    // Never trust a client-provided chain or any forwarded identity/role.
    if (config.trustLoopbackProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
      const forwarded = request.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && isIP(forwarded.trim())) key = forwarded.trim();
    }
    if (!limiter.consume(key, now())) throw new HttpError(429, 'Muitas tentativas. Aguarde antes de tentar novamente', Math.ceil(rateConfig.windowMs / 1000));
  }

  async function staticFile(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    let directory: string;
    let requested: string;
    const demo = pathname === '/demo' || pathname.startsWith('/demo/');
    if (pathname === '/') { directory = publicDirectory; requested = 'index.html'; }
    else if (pathname === '/app' || pathname === '/app/') { directory = publicDirectory; requested = 'operations.html'; }
    else if (['/account.js', '/account.css', '/operations.js', '/operations.css', '/map.js', '/map.css',
      '/vendor/leaflet.js', '/vendor/leaflet.css', '/vendor/images/marker-icon.png', '/vendor/images/marker-icon-2x.png',
      '/vendor/images/marker-shadow.png', '/vendor/images/layers.png', '/vendor/images/layers-2x.png'].includes(pathname)) {
      directory = publicDirectory; requested = pathname.slice(1);
    }
    else if (pathname.startsWith('/assets/')) { directory = publicDirectory; requested = pathname.slice(1); }
    else if (demo) { directory = demoDirectory; requested = pathname === '/demo' || pathname === '/demo/' ? 'index.html' : pathname.slice('/demo/'.length); }
    else return false;
    if (!mimeTypes[extname(requested)] || requested.includes('\\') || requested.includes('\0')) return false;
    try {
      const root = await realpath(directory);
      const candidate = await realpath(resolve(root, requested));
      const contained = relative(root, candidate);
      if (contained.startsWith('..') || isAbsolute(contained)) return false;
      const info = await stat(candidate);
      if (!info.isFile()) return false;
      const content = request.method === 'HEAD' ? null : await readFile(candidate);
      const interactive = demo || pathname === '/app' || pathname === '/app/';
      const csp = "default-src 'self'; script-src 'self'; style-src 'self'" + (interactive ? " 'unsafe-inline'" : '') + "; img-src 'self' data: " + tileUrl.origin + "; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(requested)]!, 'Content-Length': info.size, 'Cache-Control': 'no-store', 'Content-Security-Policy': csp });
      response.end(content);
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) return false;
      throw error;
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(request.url ?? '/', config.origin);
      if (url.origin !== config.origin) throw new HttpError(400, 'Requisição inválida');
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Caminho inválido'); }
      const method = request.method ?? 'GET';
      if (pathname === '/health' && method === 'GET') { json(response, 200, { status: 'ok' }); return; }
      if (pathname === '/api/map-config' && method === 'GET') {
        json(response, 200, { tileUrl: mapTileUrl, attribution: '© OpenStreetMap contributors' });
        return;
      }
      if (pathname === '/demo' && ['GET', 'HEAD'].includes(method)) {
        response.writeHead(308, { Location: '/demo/', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (pathname === '/api/auth/register' || pathname === '/api/auth/login') {
        if (method !== 'POST') throw new HttpError(405, 'Método não permitido');
        guardMutation(request);
        rateLimit(request);
        const value = await readBody(request);
        if (pathname.endsWith('/register')) {
          const data = registration(value);
          const passwordHash = await passwordOperation(() => hashPassword(data.password));
          const userId = randomUUID();
          const createdAt = new Date(now()).toISOString();
          let token: string;
          try {
            token = transaction(database, () => {
              database.prepare('INSERT INTO titoja_users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(userId, data.email, passwordHash, createdAt);
              database.prepare('INSERT INTO titoja_profiles (user_id, role, name, establishment_name, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, data.role, data.name, data.establishmentName, createdAt);
              return createSession(userId, request);
            });
          } catch (error) {
            if (error instanceof Error && error.message.includes('UNIQUE constraint failed: titoja_users.email')) throw new HttpError(409, 'Não foi possível cadastrar com esse e-mail');
            throw error;
          }
          json(response, 201, profileForUser(database, userId), { 'Set-Cookie': sessionCookie(token), 'X-Titoja-User': userId });
          return;
        }
        fields(value, ['email', 'password']);
        const email = emailAddress(value.email);
        const password = passwordValue(value.password);
        const row = database.prepare('SELECT id, password_hash FROM titoja_users WHERE email = ?').get(email);
        const valid = await passwordOperation(() => verifyPassword(password, row ? String(row.password_hash) : null));
        if (!row || !valid) throw new HttpError(401, 'E-mail ou senha inválidos');
        const account = profileForUser(database, String(row.id));
        const token = transaction(database, () => createSession(String(row.id), request));
        json(response, 200, account, { 'Set-Cookie': sessionCookie(token), 'X-Titoja-User': account.profile.user_id });
        return;
      }
      if (pathname === '/api/auth/logout') {
        if (method !== 'POST') throw new HttpError(405, 'Método não permitido');
        guardMutation(request);
        if (request.headers['x-titoja-user'] !== undefined) guardSessionIdentity(request, authenticate(request, response));
        const value = await readBody(request);
        fields(value, []);
        const token = tokenFromCookie(request, cookieName);
        if (token) database.prepare('DELETE FROM titoja_sessions WHERE token_hash = ?').run(sessionHash(token));
        json(response, 200, { ok: true }, { 'Set-Cookie': clearedCookie() });
        return;
      }
      if (pathname === '/api/auth/password-reset') {
        if (method !== 'POST') throw new HttpError(405, 'Método não permitido');
        guardMutation(request);
        const value = await readBody(request);
        fields(value, ['email']);
        emailAddress(value.email);
        throw new HttpError(501, 'Recuperação de senha indisponível: o provedor de e-mail ainda não foi configurado');
      }
      if (pathname === '/api/account') {
        if (method !== 'GET') throw new HttpError(405, 'O perfil não pode ser alterado por esta API');
        json(response, 200, authenticate(request, response));
        return;
      }
      if (pathname === '/api/dashboard') {
        if (method !== 'GET') throw new HttpError(405, 'Método não permitido');
        const account = authenticate(request, response);
        const role = url.searchParams.get('role');
        if (!roles.includes(role as Role) || url.searchParams.getAll('role').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'role')) throw new HttpError(400, 'Perfil inválido');
        if (account.profile.role !== role) throw new HttpError(403, 'Seu perfil não tem acesso a esta área');
        json(response, 200, { profile: account.profile });
        return;
      }
      if (pathname === '/api/stores' || pathname.startsWith('/api/stores/') || pathname === '/api/store' || pathname.startsWith('/api/store/')) {
        const publicRead = method === 'GET' && (pathname === '/api/stores' || pathname.startsWith('/api/stores/'));
        const account = publicRead ? undefined : authenticate(request, response);
        let value: Record<string, unknown> | undefined;
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) { guardMutation(request); guardSessionIdentity(request, account!); value = await readBody(request); }
        const result = catalog.handle({ method, pathname, url, account, body: value });
        if (!result) throw new HttpError(404, 'Recurso não encontrado');
        json(response, result.status, result.body);
        return;
      }
      if (pathname === '/api/orders' || pathname.startsWith('/api/orders/')) {
        const account = authenticate(request, response);
        let value: Record<string, unknown> | undefined;
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) { guardMutation(request, 16 * 1024); guardSessionIdentity(request, account); value = await readBody(request, 16 * 1024); }
        const result = orders.handle({ method, pathname, url, account, body: value });
        if (!result) throw new HttpError(404, 'Recurso não encontrado');
        json(response, result.status, result.body);
        return;
      }
      if (pathname === '/api/db-verification') throw new HttpError(410, 'Endpoint de verificação desativado');
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'Recurso não encontrado');
      if (!['GET', 'HEAD'].includes(method)) throw new HttpError(405, 'Método não permitido');
      if (await staticFile(request, response, pathname)) return;
      throw new HttpError(404, 'Página não encontrada');
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const expected = error instanceof HttpError || error instanceof CatalogError || error instanceof OrderError;
      const status = expected ? error.status : 500;
      json(response, status, { error: expected ? error.message : 'Não foi possível concluir. Tente novamente', ...(error instanceof HttpError && error.code ? { code: error.code } : {}) }, {
        ...(error instanceof HttpError && error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}),
        ...(status === 413 ? { Connection: 'close' } : {}),
      });
    }
  }

  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => { void handle(request, response); });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (server.listening) {
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    }
    database.close();
  }
  const sqliteVersion = String(database.prepare('SELECT sqlite_version() AS version').get()?.version);
  return { server, database, sqliteVersion, close };
}
