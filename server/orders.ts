import { randomUUID, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.js';
import { CatalogService, CatalogError } from './catalog.js';

export const services = ['moto', 'car', 'delivery', 'food', 'market', 'pharmacy', 'beer'] as const;
type Service = typeof services[number];
type Role = 'client' | 'courier' | 'driver' | 'establishment';
type Status = 'requested' | 'merchant_accepted' | 'preparing' | 'ready' | 'assigned' | 'heading_to_pickup' | 'picked_up' | 'in_transit' | 'completed' | 'cancelled' | 'rejected';
type Actor = { user_id: string; role: Role; name: string };
type Account = { profile: { user_id: string; role: string; name: string } };
type OrderRow = {
  id: string; customer_id: string; worker_id: string | null; store_id: string | null;
  store_owner_id: string | null; store_name: string | null; service: Service; delivery_type: string | null;
  pickup_address: string; dropoff_address: string; pickup_area: string; dropoff_area: string;
  pickup_latitude: number | null; pickup_longitude: number | null; dropoff_latitude: number | null; dropoff_longitude: number | null;
  note: string; status: Status; version: number; request_id: string; request_hash: string;
  payment_status: 'simulated'; subtotal_cents: number | null; created_at: string; updated_at: string;
};
type ItemRow = { product_id: string; name: string; unit_price_cents: number; quantity: number; line_total_cents: number };
type LocationRow = { latitude: number; longitude: number; accuracy: number; updated_at: string };
type DeliveryCode = { code_hash: string; salt: string; expires_at: number; attempts: number; window_started: number };
export type OrderRequest = { method: string; pathname: string; url: URL; account: Account; body?: Record<string, unknown> };
export class OrderError extends Error { constructor(public status: number, message: string) { super(message); } }
const active = new Set<Status>(['assigned', 'heading_to_pickup', 'picked_up', 'in_transit']);
const commercial = new Set<Service>(['food', 'market', 'pharmacy', 'beer']);

function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new OrderError(400, 'Campo não permitido');
  }
}
function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u001f\u007f<>]/u.test(value)) {
    throw new OrderError(400, `${field}: informe entre ${min} e ${max} caracteres, sem marcação HTML`);
  }
  return value.trim();
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new OrderError(400, 'Versão do pedido inválida');
  return value as number;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(value)) throw new OrderError(400, `${label} inválido`);
  return value;
}
function itemsInput(value: unknown): { productId: string; quantity: number }[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new OrderError(400, 'Escolha de 1 a 50 produtos');
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new OrderError(400, 'Produto inválido');
    fields(item as Record<string, unknown>, ['productId', 'quantity']);
    const productId = identifier(item.productId, 'Produto');
    if (ids.has(productId)) throw new OrderError(400, 'Produto duplicado');
    ids.add(productId);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw new OrderError(400, 'Quantidade inválida');
    return { productId, quantity: item.quantity as number };
  });
}
function coordinates(body: Record<string, unknown>, prefix: 'pickup' | 'dropoff'): { latitude: number | null; longitude: number | null } {
  const latitude = body[`${prefix}Latitude`];
  const longitude = body[`${prefix}Longitude`];
  if (latitude === undefined && longitude === undefined) return { latitude: null, longitude: null };
  if (latitude === null && longitude === null) return { latitude: null, longitude: null };
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new OrderError(400, 'Informe um par de coordenadas válido');
  return { latitude, longitude };
}
function deliveryHash(salt: string, code: string): string { return createHash('sha256').update(`${salt}:${code}`).digest('hex'); }

/** Synchronous SQLite operations stay inside short transactions; password/network work never runs here. */
export class OrderService {
  private readonly catalog: CatalogService;
  constructor(private readonly database: DatabaseSync, private readonly now: () => number = Date.now) {
    this.catalog = new CatalogService(database, now);
  }

  private actor(account: Account): Actor {
    if (typeof account?.profile?.user_id !== 'string') throw new OrderError(401, 'Entre na sua conta para continuar');
    const actor = this.database.prepare('SELECT user_id, role, name FROM titoja_profiles WHERE user_id = ?').get(account.profile.user_id) as Actor | undefined;
    if (!actor) throw new OrderError(401, 'Entre na sua conta para continuar');
    return actor;
  }
  private row(id: string): OrderRow {
    const row = this.database.prepare('SELECT * FROM titoja_orders WHERE id = ?').get(id) as OrderRow | undefined;
    if (!row) throw new OrderError(404, 'Pedido não encontrado');
    return row;
  }
  private participant(row: OrderRow, actor: Actor): void {
    if (row.customer_id !== actor.user_id && row.worker_id !== actor.user_id && row.store_owner_id !== actor.user_id) {
      // Unknown and inaccessible IDs have the same response.
      throw new OrderError(404, 'Pedido não encontrado');
    }
  }
  private actions(row: OrderRow, actor: Actor): string[] {
    if (row.customer_id === actor.user_id && actor.role === 'client' && row.status === 'requested') return ['cancel'];
    if (row.store_owner_id === actor.user_id && actor.role === 'establishment') {
      if (row.status === 'requested') return ['merchantAccept', 'reject'];
      if (row.status === 'merchant_accepted') return ['startPreparing'];
      if (row.status === 'preparing') return ['markReady'];
    }
    if (row.worker_id === actor.user_id && (actor.role === 'courier' || actor.role === 'driver')) {
      if (row.status === 'assigned') return ['goPickup'];
      if (row.status === 'heading_to_pickup') return ['confirmPickup'];
      if (row.status === 'picked_up') return ['startDelivery'];
      if (row.status === 'in_transit') return ['complete'];
    }
    return [];
  }
  private location(row: OrderRow): null | { latitude: number; longitude: number; accuracy: number; updatedAt: string; stale: boolean } {
    if (!active.has(row.status)) return null;
    const location = this.database.prepare('SELECT latitude, longitude, accuracy, updated_at FROM titoja_order_locations WHERE order_id = ? AND worker_id = ?').get(row.id, row.worker_id) as LocationRow | undefined;
    return location ? { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy, updatedAt: location.updated_at, stale: this.now() - Date.parse(location.updated_at) > 120000 } : null;
  }
  private view(row: OrderRow, actor: Actor) {
    this.participant(row, actor);
    const items = this.database.prepare('SELECT product_id, name, unit_price_cents, quantity, line_total_cents FROM titoja_order_items WHERE order_id = ? ORDER BY product_id').all(row.id) as ItemRow[];
    const history = this.database.prepare('SELECT id, status, action, actor_role, at FROM titoja_order_events WHERE order_id = ? ORDER BY id').all(row.id);
    return {
      id: row.id, service: row.service, deliveryType: row.delivery_type, status: row.status, version: row.version,
      customerId: row.customer_id, workerId: row.worker_id, storeId: row.store_id, storeOwnerId: row.store_owner_id, storeName: row.store_name,
      pickupAddress: row.pickup_address, dropoffAddress: row.dropoff_address, pickupArea: row.pickup_area, dropoffArea: row.dropoff_area,
      pickupLatitude: row.pickup_latitude, pickupLongitude: row.pickup_longitude, dropoffLatitude: row.dropoff_latitude, dropoffLongitude: row.dropoff_longitude,
      note: row.note, paymentStatus: row.payment_status, subtotalCents: row.subtotal_cents,
      deliveryFeeCents: null, totalCents: null, createdAt: row.created_at, updatedAt: row.updated_at,
      items: items.map(item => ({ productId: item.product_id, name: item.name, unitPriceCents: item.unit_price_cents, quantity: item.quantity, lineTotalCents: item.line_total_cents })),
      history: history.map(event => ({ id: event.id, status: event.status, action: event.action, actorRole: event.actor_role, at: event.at })),
      latestLocation: this.location(row), availableActions: this.actions(row, actor),
      canGenerateDeliveryCode: row.customer_id === actor.user_id && actor.role === 'client' && active.has(row.status),
      canShareLocation: row.worker_id === actor.user_id && active.has(row.status) && (actor.role === 'driver' || actor.role === 'courier')
    };
  }
  private event(row: OrderRow, actor: Actor, action: string, status: Status, at: string): void {
    this.database.prepare('INSERT INTO titoja_order_events (order_id, actor_id, actor_role, action, status, at) VALUES (?, ?, ?, ?, ?, ?)').run(row.id, actor.user_id, actor.role, action, status, at);
  }
  private list(actor: Actor) {
    const rows = this.database.prepare('SELECT * FROM titoja_orders WHERE customer_id = ? OR worker_id = ? OR store_owner_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(actor.user_id, actor.user_id, actor.user_id) as OrderRow[];
    return { orders: rows.map(row => this.view(row, actor)) };
  }
  private queue(actor: Actor) {
    if (actor.role !== 'courier' && actor.role !== 'driver') throw new OrderError(403, 'Seu perfil não pode aceitar serviços');
    const busy = Boolean(this.database.prepare("SELECT id FROM titoja_orders WHERE worker_id = ? AND status IN ('assigned','heading_to_pickup','picked_up','in_transit') LIMIT 1").get(actor.user_id));
    const rows = this.database.prepare(actor.role === 'driver'
      ? "SELECT id, service, delivery_type, status, version, pickup_area, dropoff_area, store_name, created_at FROM titoja_orders WHERE service IN ('moto','car') AND status = 'requested' AND worker_id IS NULL ORDER BY created_at, id LIMIT 100"
      : "SELECT id, service, delivery_type, status, version, pickup_area, dropoff_area, store_name, created_at FROM titoja_orders WHERE worker_id IS NULL AND ((service = 'delivery' AND status = 'requested') OR (service IN ('food','market','pharmacy','beer') AND status = 'ready')) ORDER BY created_at, id LIMIT 100").all();
    return { orders: rows.map(row => ({ id: row.id, service: row.service, deliveryType: row.delivery_type, status: row.status, version: row.version, pickupArea: row.pickup_area, dropoffArea: row.dropoff_area, storeName: row.store_name, createdAt: row.created_at, canAccept: !busy })) };
  }
  private create(actor: Actor, body: Record<string, unknown>) {
    if (actor.role !== 'client') throw new OrderError(403, 'Somente clientes podem solicitar serviços');
    fields(body, ['service', 'deliveryType', 'pickupAddress', 'dropoffAddress', 'pickupArea', 'dropoffArea', 'pickupLatitude', 'pickupLongitude', 'dropoffLatitude', 'dropoffLongitude', 'note', 'storeId', 'items', 'requestId']);
    if (!services.includes(body.service as Service)) throw new OrderError(400, 'Serviço inválido');
    const service = body.service as Service;
    const requestId = text(body.requestId, 'Identificador da solicitação', 16, 80);
    if (!/^[A-Za-z0-9_-]+$/u.test(requestId)) throw new OrderError(400, 'Identificador da solicitação inválido');
    const dropoffAddress = text(body.dropoffAddress, 'Endereço de destino', 5, 400);
    const dropoffArea = text(body.dropoffArea, 'Bairro/cidade de destino', 2, 100);
    const note = body.note === undefined || body.note === '' ? '' : text(body.note, 'Observação', 1, 1000);
    const storeId = commercial.has(service) ? identifier(body.storeId, 'Estabelecimento') : null;
    const items = commercial.has(service) ? itemsInput(body.items) : [];
    const pickupAddress = commercial.has(service) ? null : text(body.pickupAddress, 'Endereço de origem', 5, 400);
    const pickupArea = commercial.has(service) ? null : text(body.pickupArea, 'Bairro/cidade de origem', 2, 100);
    const pickupCoordinates = coordinates(body, 'pickup');
    const dropoffCoordinates = coordinates(body, 'dropoff');
    const deliveryType = body.deliveryType === undefined || body.deliveryType === '' ? null : text(body.deliveryType, 'Tipo de entrega', 2, 80);
    if (commercial.has(service) && (body.pickupAddress !== undefined || body.pickupArea !== undefined || body.pickupLatitude !== undefined || body.pickupLongitude !== undefined || deliveryType !== null)) throw new OrderError(400, 'A origem do pedido vem do estabelecimento');
    if (!commercial.has(service) && (body.storeId !== undefined || body.items !== undefined)) throw new OrderError(400, 'Este serviço não usa catálogo');
    if (service !== 'delivery' && deliveryType !== null) throw new OrderError(400, 'Tipo de entrega permitido somente em entregas');
    const normalized = { service, requestId, dropoffAddress, dropoffArea, note, storeId, items, pickupAddress, pickupArea, pickupCoordinates, dropoffCoordinates, deliveryType };
    const requestHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    try {
      return transaction(this.database, () => {
        const existing = this.database.prepare('SELECT * FROM titoja_orders WHERE customer_id = ? AND request_id = ?').get(actor.user_id, requestId) as OrderRow | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) throw new OrderError(409, 'Esta solicitação já foi usada para outro pedido');
          return { status: 200, body: { order: this.view(existing, actor) } };
        }
        const quote = storeId ? this.catalog.quoteForOrder(storeId, items, service) : null;
        const at = new Date(this.now()).toISOString();
        const id = randomUUID();
        this.database.prepare(`INSERT INTO titoja_orders (id, customer_id, worker_id, store_id, store_owner_id, store_name, service, delivery_type, pickup_address, dropoff_address, pickup_area, dropoff_area, pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude, note, status, version, request_id, request_hash, payment_status, subtotal_cents, created_at, updated_at)
          VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', 1, ?, ?, 'simulated', ?, ?, ?)`).run(
          id, actor.user_id, storeId, quote?.store.owner_id ?? null, quote?.store.name ?? null, service, deliveryType,
          quote?.store.pickup_address ?? pickupAddress!, dropoffAddress, quote?.store.pickup_area ?? pickupArea!, dropoffArea,
          quote ? quote.store.pickup_latitude : pickupCoordinates.latitude, quote ? quote.store.pickup_longitude : pickupCoordinates.longitude,
          dropoffCoordinates.latitude, dropoffCoordinates.longitude, note, requestId, requestHash, quote?.subtotal_cents ?? null, at, at);
        if (quote) for (const item of quote.items) this.database.prepare('INSERT INTO titoja_order_items (order_id, product_id, name, unit_price_cents, quantity, line_total_cents) VALUES (?, ?, ?, ?, ?, ?)').run(id, item.product_id, item.name, item.unit_price_cents, item.quantity, item.line_total_cents);
        const row = this.row(id);
        this.event(row, actor, 'create', 'requested', at);
        return { status: 201, body: { order: this.view(row, actor) } };
      });
    } catch (error) {
      if (error instanceof CatalogError) throw new OrderError(error.status, error.message);
      throw error;
    }
  }
  private accept(actor: Actor, id: string, body: Record<string, unknown>) {
    fields(body, ['expectedVersion']);
    const expectedVersion = version(body.expectedVersion);
    if (actor.role !== 'driver' && actor.role !== 'courier') throw new OrderError(403, 'Seu perfil não pode aceitar serviços');
    return transaction(this.database, () => {
      const row = this.row(id);
      const compatible = actor.role === 'driver' ? row.service === 'moto' || row.service === 'car' : row.service !== 'moto' && row.service !== 'car';
      if (!compatible) throw new OrderError(403, 'Este serviço exige outro perfil profissional');
      const expectedStatus = commercial.has(row.service) ? 'ready' : 'requested';
      if (row.version !== expectedVersion || row.status !== expectedStatus || row.worker_id !== null) throw new OrderError(409, 'Oferta indisponível ou atualizada. Atualize a lista');
      if (this.database.prepare("SELECT id FROM titoja_orders WHERE worker_id = ? AND status IN ('assigned','heading_to_pickup','picked_up','in_transit')").get(actor.user_id)) throw new OrderError(409, 'Conclua seu serviço atual antes de aceitar outro');
      const at = new Date(this.now()).toISOString();
      const update = this.database.prepare('UPDATE titoja_orders SET worker_id = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ? AND worker_id IS NULL AND status = ? AND version = ?').run(actor.user_id, 'assigned', at, id, expectedStatus, expectedVersion);
      if (Number(update.changes) !== 1) throw new OrderError(409, 'Outro profissional já aceitou esta oferta');
      this.event(row, actor, 'accept', 'assigned', at);
      return { order: this.view(this.row(id), actor) };
    });
  }
  private transition(actor: Actor, id: string, body: Record<string, unknown>) {
    fields(body, ['action', 'expectedVersion', 'deliveryCode']);
    const expectedVersion = version(body.expectedVersion);
    const action = text(body.action, 'Ação', 2, 40);
    const destination: Record<string, Status> = { merchantAccept: 'merchant_accepted', startPreparing: 'preparing', markReady: 'ready', reject: 'rejected', cancel: 'cancelled', goPickup: 'heading_to_pickup', confirmPickup: 'picked_up', startDelivery: 'in_transit', complete: 'completed' };
    const next = destination[action];
    if (!next) throw new OrderError(400, 'Ação inválida');
    if (action !== 'complete' && body.deliveryCode !== undefined) throw new OrderError(400, 'Código permitido somente na conclusão');
    if (action === 'complete' && (typeof body.deliveryCode !== 'string' || !/^\d{6}$/u.test(body.deliveryCode))) throw new OrderError(400, 'Informe o código individual de seis dígitos fornecido pelo cliente');
    const result = transaction(this.database, () => {
      const row = this.row(id);
      this.participant(row, actor);
      if (row.version !== expectedVersion) throw new OrderError(409, 'Pedido atualizado. Atualize antes de continuar');
      if (!this.actions(row, actor).includes(action)) throw new OrderError(403, 'Esta ação não é permitida para seu perfil nesta etapa');
      if (action === 'complete') {
        const error = this.checkDeliveryCode(id, body.deliveryCode as string);
        // Failed attempts must commit before returning the error; throwing here would roll them back.
        if (error) return { error };
      }
      const at = new Date(this.now()).toISOString();
      const update = this.database.prepare('UPDATE titoja_orders SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = ? AND version = ?').run(next, at, id, row.status, expectedVersion);
      if (Number(update.changes) !== 1) throw new OrderError(409, 'Pedido atualizado. Atualize antes de continuar');
      this.event(row, actor, action, next, at);
      if (!active.has(next)) {
        this.database.prepare('DELETE FROM titoja_order_locations WHERE order_id = ?').run(id);
        this.database.prepare('DELETE FROM titoja_delivery_codes WHERE order_id = ?').run(id);
      }
      return { order: this.view(this.row(id), actor) };
    });
    if ('error' in result) throw result.error;
    return result;
  }
  private checkDeliveryCode(id: string, supplied: string): OrderError | null {
    const code = this.database.prepare('SELECT code_hash, salt, expires_at, attempts, window_started FROM titoja_delivery_codes WHERE order_id = ?').get(id) as DeliveryCode | undefined;
    if (!code) return new OrderError(403, 'Peça ao cliente para gerar o código individual de conclusão');
    const now = this.now();
    const inWindow = now - code.window_started < 15 * 60 * 1000;
    const attempts = inWindow ? code.attempts : 0;
    if (attempts >= 5) return new OrderError(429, 'Limite de tentativas do código atingido. Aguarde ou peça um novo código ao cliente');
    const valid = timingSafeEqual(Buffer.from(code.code_hash, 'hex'), Buffer.from(deliveryHash(code.salt, supplied), 'hex')) && code.expires_at > now;
    if (valid) return null;
    this.database.prepare('UPDATE titoja_delivery_codes SET attempts = ?, window_started = ? WHERE order_id = ?').run(attempts + 1, inWindow ? code.window_started : now, id);
    return new OrderError(403, 'Código inválido ou expirado');
  }
  private deliveryCode(actor: Actor, id: string, body: Record<string, unknown>) {
    fields(body, []);
    return transaction(this.database, () => {
      const row = this.row(id);
      this.participant(row, actor);
      if (actor.role !== 'client' || row.customer_id !== actor.user_id || !active.has(row.status)) throw new OrderError(403, 'Somente o cliente pode gerar o código durante o serviço');
      const previous = this.database.prepare('SELECT code_hash, salt FROM titoja_delivery_codes WHERE order_id = ?').get(id) as Pick<DeliveryCode, 'code_hash' | 'salt'> | undefined;
      let code: string;
      do {
        code = randomInt(0, 1000000).toString().padStart(6, '0');
        // A fresh salt alone would still let an accidentally repeated six-digit value authorize completion.
      } while (previous && timingSafeEqual(Buffer.from(previous.code_hash, 'hex'), Buffer.from(deliveryHash(previous.salt, code), 'hex')));
      const salt = randomBytes(16).toString('hex');
      const now = this.now();
      const expires = now + 15 * 60 * 1000;
      this.database.prepare(`INSERT INTO titoja_delivery_codes (order_id, code_hash, salt, expires_at, attempts, window_started, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET code_hash = excluded.code_hash, salt = excluded.salt, expires_at = excluded.expires_at, attempts = 0, window_started = excluded.window_started, created_at = excluded.created_at`).run(id, deliveryHash(salt, code), salt, expires, now, now);
      // This one-time response is only returned to the customer; code/hash never appear in order views.
      return { deliveryCode: code, expiresAt: new Date(expires).toISOString() };
    });
  }
  private setLocation(actor: Actor, id: string, body: Record<string, unknown>, clear: boolean) {
    fields(body, clear ? [] : ['latitude', 'longitude', 'accuracy']);
    if (!clear) for (const [key, min, max] of [['latitude', -90, 90], ['longitude', -180, 180], ['accuracy', 0, 1000000]] as const) {
      if (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || (body[key] as number) < min || (body[key] as number) > max) throw new OrderError(400, 'Coordenadas ou precisão inválidas');
    }
    return transaction(this.database, () => {
      const row = this.row(id);
      this.participant(row, actor);
      if (row.worker_id !== actor.user_id || (!clear && !active.has(row.status)) || (actor.role !== 'driver' && actor.role !== 'courier')) throw new OrderError(403, 'Somente o profissional atribuído pode compartilhar a posição durante o serviço');
      if (clear) this.database.prepare('DELETE FROM titoja_order_locations WHERE order_id = ? AND worker_id = ?').run(id, actor.user_id);
      else this.database.prepare(`INSERT INTO titoja_order_locations (order_id, worker_id, latitude, longitude, accuracy, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET worker_id = excluded.worker_id, latitude = excluded.latitude, longitude = excluded.longitude, accuracy = excluded.accuracy, updated_at = excluded.updated_at`).run(id, actor.user_id, body.latitude as number, body.longitude as number, body.accuracy as number, new Date(this.now()).toISOString());
      return { latestLocation: this.location(row) };
    });
  }

  handle(request: OrderRequest): { status: number; body: unknown } | null {
    if (request.pathname !== '/api/orders' && !request.pathname.startsWith('/api/orders/')) return null;
    const actor = this.actor(request.account);
    const body = request.body ?? {};
    if (request.pathname === '/api/orders') {
      if (request.method === 'GET') return { status: 200, body: this.list(actor) };
      if (request.method === 'POST') return this.create(actor, body);
      throw new OrderError(405, 'Método não permitido');
    }
    if (request.pathname === '/api/orders/queue') {
      if (request.method !== 'GET') throw new OrderError(405, 'Método não permitido');
      return { status: 200, body: this.queue(actor) };
    }
    const match = /^\/api\/orders\/([A-Za-z0-9_-]{1,80})(?:\/(accept|transition|location|delivery-code))?$/u.exec(request.pathname);
    if (!match) throw new OrderError(404, 'Pedido não encontrado');
    const id = match[1]!;
    const action = match[2];
    if (!action && request.method === 'GET') return { status: 200, body: { order: this.view(this.row(id), actor) } };
    if (action === 'accept' && request.method === 'POST') return { status: 200, body: this.accept(actor, id, body) };
    if (action === 'transition' && request.method === 'POST') return { status: 200, body: this.transition(actor, id, body) };
    if (action === 'delivery-code' && request.method === 'POST') return { status: 200, body: this.deliveryCode(actor, id, body) };
    if (action === 'location' && request.method === 'GET') { const row = this.row(id); this.participant(row, actor); return { status: 200, body: { latestLocation: this.location(row) } }; }
    if (action === 'location' && (request.method === 'POST' || request.method === 'DELETE')) return { status: 200, body: this.setLocation(actor, id, body, request.method === 'DELETE') };
    throw new OrderError(405, 'Método não permitido');
  }
}
