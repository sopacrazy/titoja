import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.js';

export const storeCategories = ['food', 'market', 'pharmacy', 'beer'] as const;
export type StoreCategory = typeof storeCategories[number];
export type CatalogAccount = { profile: { user_id: string; role?: string } };
type StoreRow = {
  id: string; owner_id: string; category: StoreCategory; name: string; description: string;
  pickup_address: string; pickup_area: string; pickup_latitude: number | null; pickup_longitude: number | null; is_open: number; is_published: number;
  created_at: string; updated_at: string;
};
type ProductRow = {
  id: string; store_id: string; name: string; description: string; price_cents: number;
  is_available: number; created_at: string; updated_at: string;
};
export type ProductSnapshot = { product_id: string; name: string; unit_price_cents: number; quantity: number; line_total_cents: number };
export type CatalogQuote = {
  store: Pick<StoreRow, 'id' | 'owner_id' | 'name' | 'category' | 'pickup_address' | 'pickup_area' | 'pickup_latitude' | 'pickup_longitude'>;
  items: ProductSnapshot[];
  subtotal_cents: number;
};
export class CatalogError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new CatalogError(400, 'Envie um objeto JSON válido');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new CatalogError(400, 'Campo não permitido');
}
function text(value: unknown, minimum: number, maximum: number, label: string, multiline = false): string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/u : /[\u0000-\u001f\u007f<>]/u;
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > maximum || controls.test(value)) {
    throw new CatalogError(400, 'Informe ' + label + ' de ' + minimum + ' a ' + maximum + ' caracteres');
  }
  return value.trim();
}
function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new CatalogError(400, label + ' deve ser verdadeiro ou falso');
  return value;
}
function category(value: unknown): StoreCategory {
  if (typeof value !== 'string' || !storeCategories.includes(value as StoreCategory)) throw new CatalogError(400, 'Categoria inválida');
  return value as StoreCategory;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    throw new CatalogError(404, 'Registro não encontrado');
  }
  return value.toLowerCase();
}
function price(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
    throw new CatalogError(400, 'Preço deve ser um inteiro de 0 a 10000000 centavos');
  }
  return value;
}
function coordinates(value: Record<string, unknown>): { latitude: number | null; longitude: number | null } | undefined {
  if (!Object.hasOwn(value, 'pickupLatitude') && !Object.hasOwn(value, 'pickupLongitude')) return undefined;
  if (value.pickupLatitude === null && value.pickupLongitude === null) return { latitude: null, longitude: null };
  if (typeof value.pickupLatitude !== 'number' || !Number.isFinite(value.pickupLatitude) || Math.abs(value.pickupLatitude) > 90 ||
      typeof value.pickupLongitude !== 'number' || !Number.isFinite(value.pickupLongitude) || Math.abs(value.pickupLongitude) > 180) {
    throw new CatalogError(400, 'Informe latitude e longitude válidas juntas, ou ambas vazias');
  }
  return { latitude: value.pickupLatitude, longitude: value.pickupLongitude };
}
function publicProduct(row: ProductRow) {
  return { id: row.id, name: row.name, description: row.description, price_cents: row.price_cents, is_available: Boolean(row.is_available) };
}

export class CatalogService {
  constructor(private readonly database: DatabaseSync, private readonly now: () => number = Date.now) {}

  private actor(account?: CatalogAccount | null): string {
    const userId = account?.profile?.user_id;
    if (!userId) throw new CatalogError(401, 'Entre na sua conta para continuar');
    const profile = this.database.prepare('SELECT role FROM titoja_profiles WHERE user_id = ?').get(userId);
    if (profile?.role !== 'establishment') throw new CatalogError(403, 'Seu perfil não tem acesso à gestão de estabelecimento');
    return userId;
  }

  private ownedRow(userId: string): StoreRow | undefined {
    return this.database.prepare('SELECT * FROM titoja_stores WHERE owner_id = ?').get(userId) as StoreRow | undefined;
  }

  private products(storeId: string, availableOnly: boolean): ProductRow[] {
    return this.database.prepare('SELECT * FROM titoja_products WHERE store_id = ?' + (availableOnly ? ' AND is_available = 1' : '') + ' ORDER BY created_at, id').all(storeId) as ProductRow[];
  }

  private ownedView(store: StoreRow) {
    return {
      id: store.id, category: store.category, name: store.name, description: store.description,
      pickup_address: store.pickup_address, pickup_area: store.pickup_area,
      pickup_latitude: store.pickup_latitude, pickup_longitude: store.pickup_longitude,
      is_open: Boolean(store.is_open), is_published: Boolean(store.is_published),
      created_at: store.created_at, updated_at: store.updated_at,
      products: this.products(store.id, false).map(row => ({ ...publicProduct(row), created_at: row.created_at, updated_at: row.updated_at }))
    };
  }

  listStores(requestedCategory?: unknown) {
    const selected = requestedCategory === undefined || requestedCategory === null ? null : category(requestedCategory);
    const stores = this.database.prepare(`SELECT s.id, s.category, s.name, s.description, s.pickup_area, s.is_open,
      (SELECT COUNT(*) FROM titoja_products p WHERE p.store_id = s.id AND p.is_available = 1) AS products_count
      FROM titoja_stores s WHERE s.is_published = 1${selected ? ' AND s.category = ?' : ''} ORDER BY s.created_at, s.id`).all(...(selected ? [selected] : []));
    return stores.map(row => ({ ...row, is_open: Boolean(row.is_open) }));
  }

  getPublicStore(storeId: unknown) {
    const store = this.database.prepare('SELECT * FROM titoja_stores WHERE id = ? AND is_published = 1').get(id(storeId)) as StoreRow | undefined;
    if (!store) throw new CatalogError(404, 'Estabelecimento não encontrado');
    return {
      id: store.id, category: store.category, name: store.name, description: store.description,
      pickup_area: store.pickup_area, is_open: Boolean(store.is_open),
      products: this.products(store.id, true).map(publicProduct)
    };
  }

  getOwnStore(account?: CatalogAccount | null) {
    const userId = this.actor(account);
    const store = this.ownedRow(userId);
    return store ? this.ownedView(store) : null;
  }

  saveStore(account: CatalogAccount | null | undefined, payload: unknown) {
    const userId = this.actor(account);
    const value = object(payload);
    fields(value, ['category', 'name', 'description', 'pickupAddress', 'pickupArea', 'pickupLatitude', 'pickupLongitude', 'isOpen', 'isPublished']);
    const data = {
      category: category(value.category), name: text(value.name, 2, 100, 'o nome'),
      description: value.description === undefined ? '' : text(value.description, 0, 1000, 'a descrição', true),
      address: text(value.pickupAddress, 5, 240, 'o endereço de retirada'), area: text(value.pickupArea, 2, 100, 'o bairro/cidade de retirada'),
      coordinates: coordinates(value)
    };
    return transaction(this.database, () => {
      const previous = this.ownedRow(userId);
      const open = boolean(value.isOpen, Boolean(previous?.is_open), 'Aberto');
      const published = boolean(value.isPublished, Boolean(previous?.is_published), 'Publicado');
      const timestamp = new Date(this.now()).toISOString();
      const storeId = previous?.id ?? randomUUID();
      const latitude = data.coordinates === undefined ? (previous?.pickup_latitude ?? null) : data.coordinates.latitude;
      const longitude = data.coordinates === undefined ? (previous?.pickup_longitude ?? null) : data.coordinates.longitude;
      if (previous) {
        this.database.prepare(`UPDATE titoja_stores SET category = ?, name = ?, description = ?, pickup_address = ?, pickup_area = ?, pickup_latitude = ?, pickup_longitude = ?, is_open = ?, is_published = ?, updated_at = ? WHERE id = ? AND owner_id = ?`)
          .run(data.category, data.name, data.description, data.address, data.area, latitude, longitude, Number(open), Number(published), timestamp, storeId, userId);
      } else {
        this.database.prepare(`INSERT INTO titoja_stores (id, owner_id, category, name, description, pickup_address, pickup_area, pickup_latitude, pickup_longitude, is_open, is_published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(storeId, userId, data.category, data.name, data.description, data.address, data.area, latitude, longitude, Number(open), Number(published), timestamp, timestamp);
      }
      return this.ownedView(this.ownedRow(userId)!);
    });
  }

  createProduct(account: CatalogAccount | null | undefined, payload: unknown) {
    const userId = this.actor(account);
    const value = object(payload);
    fields(value, ['name', 'description', 'priceCents', 'isAvailable']);
    const name = text(value.name, 2, 100, 'o nome');
    const description = value.description === undefined ? '' : text(value.description, 0, 1000, 'a descrição', true);
    const amount = price(value.priceCents);
    const available = boolean(value.isAvailable, true, 'Disponibilidade');
    return transaction(this.database, () => {
      const store = this.ownedRow(userId);
      if (!store) throw new CatalogError(409, 'Cadastre seu estabelecimento antes de adicionar produtos');
      const count = this.database.prepare('SELECT COUNT(*) AS total FROM titoja_products WHERE store_id = ?').get(store.id)?.total;
      if (Number(count) >= 100) throw new CatalogError(409, 'Limite de 100 produtos por estabelecimento atingido');
      const productId = randomUUID();
      const timestamp = new Date(this.now()).toISOString();
      this.database.prepare(`INSERT INTO titoja_products (id, store_id, name, description, price_cents, is_available, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(productId, store.id, name, description, amount, Number(available), timestamp, timestamp);
      return { id: productId, name, description, price_cents: amount, is_available: available, created_at: timestamp, updated_at: timestamp };
    });
  }

  updateProduct(account: CatalogAccount | null | undefined, productId: unknown, payload: unknown) {
    const userId = this.actor(account);
    const key = id(productId);
    const value = object(payload);
    fields(value, ['name', 'description', 'priceCents', 'isAvailable']);
    if (Object.keys(value).length === 0) throw new CatalogError(400, 'Informe ao menos um campo para atualizar');
    // Validate supplied fields before looking up the target; no partial update can be committed.
    const name = value.name === undefined ? undefined : text(value.name, 2, 100, 'o nome');
    const description = value.description === undefined ? undefined : text(value.description, 0, 1000, 'a descrição', true);
    const amount = value.priceCents === undefined ? undefined : price(value.priceCents);
    const available = value.isAvailable === undefined ? undefined : boolean(value.isAvailable, false, 'Disponibilidade');
    return transaction(this.database, () => {
      const row = this.database.prepare(`SELECT p.* FROM titoja_products p JOIN titoja_stores s ON s.id = p.store_id WHERE p.id = ? AND s.owner_id = ?`).get(key, userId) as ProductRow | undefined;
      if (!row) throw new CatalogError(404, 'Produto não encontrado');
      const timestamp = new Date(this.now()).toISOString();
      this.database.prepare('UPDATE titoja_products SET name = ?, description = ?, price_cents = ?, is_available = ?, updated_at = ? WHERE id = ?')
        .run(name ?? row.name, description ?? row.description, amount ?? row.price_cents, available === undefined ? row.is_available : Number(available), timestamp, key);
      return { ...publicProduct({ ...row, name: name ?? row.name, description: description ?? row.description, price_cents: amount ?? row.price_cents, is_available: available === undefined ? row.is_available : Number(available) }), created_at: row.created_at, updated_at: timestamp };
    });
  }

  quoteForOrder(storeId: unknown, requestedItems: unknown, requestedService: unknown): CatalogQuote {
    const selectedCategory = category(requestedService);
    const store = this.database.prepare('SELECT * FROM titoja_stores WHERE id = ?').get(id(storeId)) as StoreRow | undefined;
    if (!store || !store.is_published) throw new CatalogError(404, 'Estabelecimento não encontrado');
    if (!store.is_open) throw new CatalogError(409, 'O estabelecimento está fechado');
    if (store.category !== selectedCategory) throw new CatalogError(400, 'O estabelecimento não atende esta categoria');
    if (!Array.isArray(requestedItems) || requestedItems.length < 1 || requestedItems.length > 50) throw new CatalogError(400, 'Escolha de 1 a 50 produtos');
    const seen = new Set<string>();
    const items: ProductSnapshot[] = requestedItems.map(input => {
      const item = object(input);
      fields(item, ['productId', 'quantity']);
      const productId = id(item.productId);
      if (seen.has(productId)) throw new CatalogError(400, 'Produto repetido na sacola');
      seen.add(productId);
      if (typeof item.quantity !== 'number' || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw new CatalogError(400, 'Quantidade deve ser um inteiro de 1 a 99');
      const product = this.database.prepare('SELECT * FROM titoja_products WHERE id = ? AND store_id = ? AND is_available = 1').get(productId, store.id) as ProductRow | undefined;
      if (!product) throw new CatalogError(409, 'Um produto não está disponível neste estabelecimento');
      return { product_id: product.id, name: product.name, unit_price_cents: product.price_cents, quantity: item.quantity, line_total_cents: product.price_cents * item.quantity };
    });
    return {
      store: { id: store.id, owner_id: store.owner_id, name: store.name, category: store.category, pickup_address: store.pickup_address, pickup_area: store.pickup_area, pickup_latitude: store.pickup_latitude, pickup_longitude: store.pickup_longitude },
      items, subtotal_cents: items.reduce((sum, item) => sum + item.line_total_cents, 0)
    };
  }

  handle(context: { method: string; pathname: string; url: URL; account?: CatalogAccount | null; body?: unknown }): { status: number; body: unknown } | null {
    const { method, pathname, url, account, body } = context;
    const publicStore = /^\/api\/stores\/([^/]+)$/.exec(pathname);
    const product = /^\/api\/store\/products\/([^/]+)$/.exec(pathname);
    if (pathname !== '/api/stores' && pathname !== '/api/store' && pathname !== '/api/store/products' && !publicStore && !product) return null;
    try {
      if (pathname === '/api/stores' && method === 'GET') return { status: 200, body: { stores: this.listStores(url.searchParams.get('category')) } };
      if (publicStore && method === 'GET') return { status: 200, body: { store: this.getPublicStore(publicStore[1]) } };
      if (pathname === '/api/store' && method === 'GET') return { status: 200, body: { store: this.getOwnStore(account) } };
      if (pathname === '/api/store' && method === 'PUT') return { status: 200, body: { store: this.saveStore(account, body) } };
      if (pathname === '/api/store/products' && method === 'POST') return { status: 201, body: { product: this.createProduct(account, body) } };
      if (product && method === 'PATCH') return { status: 200, body: { product: this.updateProduct(account, product[1], body) } };
      throw new CatalogError(405, 'Método não permitido');
    } catch (error) {
      if (error instanceof CatalogError) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  }
}
