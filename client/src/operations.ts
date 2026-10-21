import { mountMap, getCurrentPosition, type MapPoint } from './map.js';
import { appPath } from './paths.js';

type Role = 'client' | 'courier' | 'driver' | 'establishment';
type Service = 'moto' | 'car' | 'delivery' | 'food' | 'market' | 'pharmacy' | 'beer';
type Profile = { user_id: string; name: string; role: Role };
type Product = { id: string; name: string; description: string; price_cents: number; is_available: boolean };
type Store = { id: string; name: string; category: Service; description: string; pickup_area: string; pickup_address?: string; pickup_latitude?: number | null; pickup_longitude?: number | null; is_open: boolean; is_published?: boolean; products?: Product[]; products_count?: number };
type Order = {
  id: string; service: Service; deliveryType: string | null; status: string; version: number;
  customerId?: string; workerId?: string | null; storeName?: string | null; storeId?: string | null;
  pickupAddress?: string; dropoffAddress?: string; pickupArea: string; dropoffArea: string; note?: string;
  subtotalCents?: number | null; paymentStatus?: string; createdAt: string; availableActions?: string[];
  canAccept?: boolean; canShareLocation?: boolean; canGenerateDeliveryCode?: boolean;
  items?: { name: string; quantity: number; lineTotalCents: number }[];
  history?: { status: string; action: string; actorRole: string; at: string }[];
  latestLocation?: { latitude: number; longitude: number; accuracy: number; updatedAt: string; stale: boolean } | null;
};
type View = { kind: 'home' | 'orders' | 'service' | 'store' | 'order' | 'manage'; id?: string; service?: Service };
const services: { id: Service; name: string; detail: string; commerce?: boolean }[] = [
  { id: 'moto', name: 'Mototáxi', detail: 'Solicitar uma corrida' },
  { id: 'car', name: 'Carro', detail: 'Viaje com motorista' },
  { id: 'delivery', name: 'Entrega', detail: 'Mercadorias, documentos e volumes' },
  { id: 'food', name: 'Comida', detail: 'Restaurantes cadastrados', commerce: true },
  { id: 'market', name: 'Mercado', detail: 'Produtos de mercados', commerce: true },
  { id: 'pharmacy', name: 'Farmácia', detail: 'Retirada e entrega', commerce: true },
  { id: 'beer', name: 'Cerveja', detail: 'Distribuidores cadastrados', commerce: true },
];
const roles: Record<Role, string> = { client: 'Cliente', courier: 'Entregador', driver: 'Motorista', establishment: 'Estabelecimento' };
const statuses: Record<string, string> = { requested: 'Solicitado', merchant_accepted: 'Aceito pela loja', preparing: 'Em preparo', ready: 'Pronto para retirada', assigned: 'Profissional atribuído', heading_to_pickup: 'A caminho da origem', picked_up: 'Retirada / embarque confirmado', in_transit: 'A caminho do destino', completed: 'Concluído', cancelled: 'Cancelado', rejected: 'Recusado' };
const actions: Record<string, string> = { merchantAccept: 'Aceitar pedido', startPreparing: 'Iniciar preparo', markReady: 'Marcar como pronto', goPickup: 'Ir à origem', confirmPickup: 'Confirmar retirada / embarque', startDelivery: 'Iniciar trajeto ao destino', complete: 'Confirmar conclusão', cancel: 'Cancelar pedido', reject: 'Recusar pedido' };
const terminal = (order: Order) => ['completed', 'cancelled', 'rejected'].includes(order.status);
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const price = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const date = (value: string) => new Date(value).toLocaleString('pt-BR');
const serviceName = (id: Service) => services.find(service => service.id === id)?.name ?? id;
const main = document.getElementById('operations')!;
const messageElement = document.getElementById('ops-message')!;
const nav = document.getElementById('ops-nav')!;
const logoutButton = document.getElementById('ops-signout') as HTMLButtonElement;
let profile: Profile | null = null;
let view: View = { kind: 'home' };
let orders: Order[] = [], queue: Order[] = [];
let selectedOrder: Order | null = null, selectedStore: Store | null = null;
let revision = 0, pending = false, operationId = 0, loadingView = false;
let readController: AbortController | null = null;
let interval: ReturnType<typeof setInterval> | undefined;
let requestId = '';
let mapController: Awaited<ReturnType<typeof mountMap>> | null = null;
let mapLoadingRevision: number | null = null;
let pins: Partial<Record<'pickup' | 'dropoff', MapPoint>> = {};
let privateCode: { orderId: string; value: string; expiresAt: string } | null = null;
let watchId: number | null = null, trackingOrderId: string | null = null, trackingRevision = 0;
let locationWrites: Promise<void> = Promise.resolve();
let lastLocationSent = 0;
let sessionChannel: BroadcastChannel | null = null;

class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
class SessionChangedError extends Error {}
const isPrivatePath = (path: string) => /^\/api\/(?:orders(?:[/?]|$)|store(?:[/?]|$))/.test(path);
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const version = revision;
  const expectedUser = profile?.user_id;
  const headers = new Headers(options.headers);
  if ((isPrivatePath(path) || path === '/api/auth/logout') && expectedUser && options.method && !['GET', 'HEAD'].includes(options.method)) headers.set('X-Titoja-User', expectedUser);
  let response: Response;
  try { response = await fetch(appPath(path, document), { credentials: 'same-origin', cache: 'no-store', ...options, headers }); }
  catch (error) { if ((error as Error).name === 'AbortError') throw error; throw new Error('Conexão indisponível. Atualize o histórico antes de reenviar uma solicitação.'); }
  let value: any;
  try { value = await response.json(); } catch { throw new Error('Não foi possível ler a resposta. Tente atualizar.'); }
  if (version !== revision || options.signal?.aborted) throw new DOMException('Esta tela já foi substituída.', 'AbortError');
  const responseUser = response.headers.get('X-Titoja-User');
  if (value?.code === 'SESSION_CHANGED' || (isPrivatePath(path) && expectedUser && (responseUser ? responseUser !== expectedUser : response.ok))) throw new SessionChangedError('A conta mudou. Atualizando o aplicativo.');
  if (!response.ok) throw new ApiError(typeof value.error === 'string' ? value.error : 'Não foi possível concluir.', response.status);
  return value as T;
}
function mutate<T>(path: string, payload: unknown, method = 'POST', keepalive = false) {
  return api<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive });
}
function message(text = '') { messageElement.textContent = text; }
function disablePending(value: boolean) {
  pending = value;
  main.querySelectorAll<HTMLButtonElement>('button[type=submit],button[data-order-action],button[data-accept],button[data-product-toggle]').forEach(button => { button.disabled = value || button.dataset.locked === 'true'; });
  logoutButton.disabled = value;
}
function failure(error: unknown) {
  if ((error as Error).name === 'AbortError') return;
  if (error instanceof SessionChangedError) { void initialize(); return; }
  if (error instanceof ApiError && error.status === 401) { signedOut(); return; }
  message((error as Error).message || 'Não foi possível concluir.');
}
function clearPrivateState() {
  profile = null;
  revision++;
  operationId++;
  readController?.abort();
  readController = null;
  loadingView = false;
  void stopSharing(false);
  destroyMap();
  nav.hidden = true;
  logoutButton.hidden = true;
  document.getElementById('ops-store-nav')!.hidden = true;
  nav.querySelectorAll('[aria-current]').forEach(button => button.removeAttribute('aria-current'));
  disablePending(false);
  privateCode = null;
  requestId = '';
  view = { kind: 'home' };
  selectedOrder = null; selectedStore = null; orders = []; queue = []; pins = {};
  document.getElementById('ops-identity')!.textContent = 'Sua conta';
  document.getElementById('ops-updated')!.textContent = '';
  message();
}
function signedOut() {
  clearPrivateState();
  main.innerHTML = `<section class="card"><h1>Entre na sua conta</h1><p>Sua sessão não está disponível. Seus pedidos continuam no banco.</p><a class="primary" href="${appPath('/', document)}">Entrar no TitoJá</a></section>`;
}
function checkedProfile(value: Profile): Profile {
  if (!value || typeof value.user_id !== 'string' || !value.user_id || typeof value.name !== 'string' || !Object.hasOwn(roles, value.role)) throw new Error('Perfil não disponível.');
  return value;
}
function showProfile(value: Profile) {
  profile = value;
  document.getElementById('ops-identity')!.textContent = roles[value.role] + ' · ' + value.name;
  nav.hidden = false; logoutButton.hidden = false;
  document.getElementById('ops-store-nav')!.hidden = value.role !== 'establishment';
}
async function verifyIdentity(controller?: AbortController): Promise<boolean> {
  const version = revision;
  const data = await api<{ profile: Profile }>('/api/account', controller ? { signal: controller.signal } : {});
  if (version !== revision || controller?.signal.aborted) return false;
  const next = checkedProfile(data.profile);
  if (!profile || next.user_id !== profile.user_id || next.role !== profile.role || next.name !== profile.name) {
    clearPrivateState();
    showProfile(next);
    await navigate({ kind: 'home' });
    return false;
  }
  return true;
}
function destroyMap() { mapController?.destroy(); mapController = null; mapLoadingRevision = null; }
async function navigate(next: View) {
  const version = ++revision;
  readController?.abort();
  loadingView = true;
  destroyMap();
  pins = {};
  privateCode = null;
  await stopSharing();
  if (version !== revision || !profile) return;
  view = next;
  selectedOrder = null;
  selectedStore = null;
  message();
  main.innerHTML = '<section class="card"><h1>Carregando.</h1></section>';
  const controller = new AbortController();
  readController = controller;
  nav.querySelectorAll<HTMLElement>('[data-nav]').forEach(button => {
    if (button.dataset.nav === next.kind) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  try {
    if (next.kind === 'service') {
      requestId = crypto.randomUUID();
      const service = services.find(service => service.id === next.service)!;
      if (service.commerce) {
        const data = await api<{ stores: Store[] }>('/api/stores?category=' + next.service, { signal: controller.signal });
        if (version !== revision) return;
        renderStores(service.id, data.stores);
      } else renderDirect(service.id);
    } else if (next.kind === 'store') {
      const data = await api<{ store: Store }>('/api/stores/' + encodeURIComponent(next.id!), { signal: controller.signal });
      if (version !== revision) return;
      selectedStore = data.store;
      requestId = crypto.randomUUID();
      renderCheckout(data.store);
    } else if (next.kind === 'manage') {
      const data = await api<{ store: Store | null }>('/api/store', { signal: controller.signal });
      if (version !== revision) return;
      selectedStore = data.store;
      if (data.store?.pickup_latitude != null && data.store.pickup_longitude != null) pins.pickup = { lat: data.store.pickup_latitude, lng: data.store.pickup_longitude };
      renderManage(data.store);
    } else if (next.kind === 'order') {
      main.innerHTML = '<div id="order-live"></div><section class="card ops-history"><h2>Acompanhamento no mapa</h2><p>O mapa é opcional. Não calcula rota ou previsão de chegada.</p><button class="secondary" type="button" data-detail-map>Abrir mapa OSM — envia a área visualizada ao provedor</button><div id="ops-detail-map" class="titoja-map" hidden></div></section>';
      loadingView = false;
      await refresh();
    } else {
      renderWorkspace();
      loadingView = false;
      await refresh();
    }
  } catch (error) { if (version === revision) failure(error); }
  finally { if (version === revision) loadingView = false; }
}
function art(id: Service) {
  if (id === 'beer') return `<img class="ops-art-image" src="${appPath('/assets/beer-3d.png', document)}" alt="">`;
  if (id === 'market') return '<div class="ops-art art-market" aria-hidden="true">🛒</div>';
  return `<div class="ops-art art-${id}" aria-hidden="true"></div>`;
}
function renderWorkspace() {
  const name = esc(profile!.name.split(' ')[0]);
  if (view.kind === 'orders') {
    main.innerHTML = '<div class="ops-welcome"><span class="eyebrow">Histórico da sua conta</span><h1>Seus pedidos e serviços</h1><p>Os registros são compartilhados somente com as contas participantes.</p></div><div id="orders-feed" class="ops-stack"></div>';
    return;
  }
  const client = profile!.role === 'client';
  main.innerHTML = `<div class="ops-layout"><section><div class="ops-welcome"><span class="eyebrow">${roles[profile!.role]}</span><h1>Olá, ${name}!</h1><p>${client ? 'O que vai ser hoje?' : profile!.role === 'establishment' ? 'Sua loja e seus pedidos, em um só lugar.' : 'Acompanhe seus serviços e as ofertas disponíveis.'}</p></div>
    ${client ? `<div class="ops-services">${services.map(service => `<button class="ops-service" type="button" data-service="${service.id}">${art(service.id)}<h2>${service.name}</h2><small>${service.detail}</small></button>`).join('')}</div>` : ''}
    ${profile!.role === 'establishment' ? '<a class="primary" href="#manage" data-nav="manage">Gerenciar loja e produtos</a>' : ''}
    ${['courier', 'driver'].includes(profile!.role) ? '<div class="ops-section-title"><h2>Ofertas disponíveis</h2></div><div id="queue-feed" class="ops-stack"></div><p><small>Antes do aceite, você vê somente as áreas aproximadas. Os endereços são liberados ao profissional atribuído.</small></p>' : ''}
    <div class="ops-section-title"><h2>${client ? 'Seus pedidos' : 'Seus serviços e pedidos'}</h2><button class="secondary" type="button" data-nav="orders">Ver histórico</button></div><div id="orders-feed" class="ops-stack"></div>
    </section><aside class="ops-aside"><img src="${appPath('/assets/delivery-scooter.png', document)}" alt="Scooter laranja, ilustração do TitoJá"><span class="eyebrow">Um passo de cada vez</span><h2>Seu pedido,<br>cada etapa.</h2><p>Os participantes atualizam o pedido. As informações são consultadas a cada 5 segundos e também pelo botão Atualizar.</p><p>Pagamento simulado, sem cobrança. Não há e-mail, SMS ou notificação externa.</p></aside></div>`;
}
function card(order: Order, offer = false) {
  return `<article class="ops-order"><h3>${esc(serviceName(order.service))} · ${esc(order.id)}</h3><span class="ops-status ${terminal(order) ? 'terminal' : ''}">${esc(statuses[order.status] ?? order.status)}</span>
    <p>${esc(order.pickupArea)} → ${esc(order.dropoffArea)}</p>${order.storeName ? `<small>${esc(order.storeName)}</small>` : ''}<small>${date(order.createdAt)}</small>
    <small>${order.subtotalCents != null ? 'Produtos: ' + price(order.subtotalCents) + ' · ' : ''}Frete / corrida: valor a combinar · pagamento simulado</small>
    <div class="ops-row">${offer ? `<button class="primary" type="button" data-accept="${esc(order.id)}" data-version="${order.version}">Aceitar oferta</button>` : `<button class="secondary" type="button" data-order="${esc(order.id)}">Acompanhar pedido</button>`}</div></article>`;
}
function renderFeeds() {
  const feed = document.getElementById('orders-feed');
  if (feed) feed.innerHTML = orders.length ? (view.kind === 'home' ? orders.slice(0, 5) : orders).map(order => card(order)).join('') : '<div class="ops-empty">Nenhum pedido registrado para esta conta.</div>';
  const offers = document.getElementById('queue-feed');
  if (offers) offers.innerHTML = queue.length ? queue.map(order => card(order, true)).join('') : '<div class="ops-empty">Nenhuma oferta disponível agora. A lista será atualizada automaticamente.</div>';
}
async function refresh() {
  if (pending || loadingView || document.hidden) return;
  if (!profile) { await initialize(); return; }
  const version = revision;
  readController?.abort();
  const controller = new AbortController();
  readController = controller;
  const current = () => version === revision && readController === controller && !controller.signal.aborted;
  try {
    if (!await verifyIdentity(controller) || !current()) return;
    if (view.kind === 'order') {
      const data = await api<{ order: Order }>('/api/orders/' + encodeURIComponent(view.id!), { signal: controller.signal });
      if (!current()) return;
      selectedOrder = data.order;
      if (!data.order.canShareLocation && trackingOrderId) await stopSharing();
      if (!current()) return;
      renderOrder(data.order);
      const point = data.order.latestLocation;
      mapController?.setTrackedPoint(point && !point.stale ? { lat: point.latitude, lng: point.longitude } : null);
    } else if (view.kind === 'home' || view.kind === 'orders') {
      const [own, offers] = await Promise.all([
        api<{ orders: Order[] }>('/api/orders', { signal: controller.signal }),
        ['courier', 'driver'].includes(profile.role) ? api<{ orders: Order[] }>('/api/orders/queue', { signal: controller.signal }) : Promise.resolve({ orders: [] }),
      ]);
      if (!current()) return;
      orders = own.orders; queue = offers.orders;
      renderFeeds();
    }
    document.getElementById('ops-updated')!.textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR');
  } catch (error) { if (current()) failure(error); }
}
function field(name: string, label: string, value = '', min = 2, max = 100) {
  return `<label class="field"><span>${label}</span><input name="${name}" value="${esc(value)}" minlength="${min}" maxlength="${max}" required></label>`;
}
function destinationFields() {
  return `<div class="ops-two-fields">${field('dropoffAddress', 'Endereço completo de destino', '', 5, 400)}${field('dropoffArea', 'Bairro / área do destino (visível nas ofertas)', '', 2, 100)}</div>`;
}
function mapFields(kinds: ('pickup' | 'dropoff')[]) {
  return `<section class="note"><strong>Localização opcional</strong><p>Digite os endereços completos acima. Pinos e GPS não verificam o endereço, nem calculam rota ou previsão de chegada.</p>
    <div class="ops-row">${kinds.map(kind => `<button class="secondary" type="button" data-use-location="${kind}">Usar minha localização como ${kind === 'pickup' ? 'origem' : 'destino'}</button>`).join('')}</div>
    <p><small>O GPS pede permissão do navegador. As coordenadas do pedido ficam visíveis somente aos participantes.</small></p>
    <div class="ops-row">${kinds.map((kind, index) => `<label><input type="radio" name="mapTarget" value="${kind}" ${index === 0 ? 'checked' : ''}> ${kind === 'pickup' ? 'Pino da origem' : 'Pino do destino'}</label>`).join('')}</div>
    <button class="secondary" type="button" data-open-map>Abrir mapa OSM — envia a área visualizada ao provedor</button>
    <div id="ops-form-map" class="titoja-map" hidden></div>
    ${kinds.map(kind => `<p id="pin-${kind}"><small>${kind === 'pickup' ? 'Origem' : 'Destino'}: ${pins[kind] ? esc(pins[kind]!.lat.toFixed(5) + ', ' + pins[kind]!.lng.toFixed(5)) : 'sem coordenadas selecionadas'}</small></p>`).join('')}
    <button class="secondary" type="button" data-clear-pins>Remover coordenadas opcionais</button></section>`;
}
function paymentField() { return '<label class="ops-check"><input name="paymentSimulation" type="checkbox" required><span>Entendo que o pagamento é <strong>simulado, sem cobrança</strong>. Frete e corridas têm valor a combinar; este app não recebe pagamento.</span></label>'; }
function renderDirect(service: Service) {
  main.innerHTML = `<button class="secondary ops-back" type="button" data-nav="home">Voltar</button><h1>${serviceName(service)}</h1><p>Preencha a origem e o destino. O profissional aceitará a solicitação na própria conta.</p>
    <form class="card ops-form" id="order-form"><div class="ops-two-fields">${field('pickupAddress', 'Endereço completo de origem', '', 5, 400)}${field('pickupArea', 'Bairro / área de origem (visível nas ofertas)', '', 2, 100)}</div>${destinationFields()}
    ${service === 'delivery' ? '<label class="field"><span>O que será entregue?</span><select name="deliveryType"><option>Mercadoria</option><option>Documento</option><option>Volume</option><option>Outros</option></select></label>' : ''}
    <label class="field"><span>Observações (opcional)</span><textarea name="note" maxlength="1000"></textarea></label>${mapFields(['pickup', 'dropoff'])}${paymentField()}<p>Frete / corrida: <strong>valor a combinar</strong>. Sem cotação ou prazo inventado.</p><button class="primary" type="submit">Solicitar ${serviceName(service)}</button></form>`;
}
function renderStores(category: Service, stores: Store[]) {
  main.innerHTML = `<button class="secondary ops-back" type="button" data-nav="home">Voltar</button><h1>${serviceName(category)}</h1>${category === 'pharmacy' ? '<div class="note">Retirada e entrega. Sem dispensação, receita automatizada ou orientação de medicamento.</div>' : ''}
    <p>Somente estabelecimentos que publicaram seu próprio cadastro aparecem aqui.</p><div class="ops-stack">${stores.length ? stores.map(store => `<article class="card"><h2>${esc(store.name)}</h2><p>${esc(store.description)}</p><p>${esc(store.pickup_area)}</p><small>${store.is_open ? 'Aberto para pedidos' : 'Fechado para pedidos'} · ${store.products_count ?? 0} produtos</small><div class="ops-actions"><button class="primary" type="button" data-store="${esc(store.id)}">Ver produtos</button></div></article>`).join('') : '<div class="ops-empty">Nenhum estabelecimento publicado nesta categoria. Não há lojas ou produtos de exemplo no aplicativo real.</div>'}</div>`;
}
function renderCheckout(store: Store) {
  main.innerHTML = `<button class="secondary ops-back" type="button" data-service="${store.category}">Voltar</button><h1>${esc(store.name)}</h1><p>${esc(store.description)} · ${esc(store.pickup_area)}</p>${!store.is_open ? '<div class="note">Esta loja está fechada para pedidos.</div>' : ''}${store.category === 'pharmacy' ? '<div class="note">Retirada e entrega; sem dispensação ou receita automatizada.</div>' : ''}
    <form class="card ops-form" id="commerce-form"><h2>Produtos</h2>${store.products?.length ? store.products.map(product => `<article class="ops-product"><div><h3>${esc(product.name)}</h3><p>${esc(product.description)}</p><div class="ops-product-price">${price(product.price_cents)}</div></div><label>Quantidade<input type="number" data-quantity="${esc(product.id)}" value="0" min="0" max="99" step="1" aria-label="Quantidade de ${esc(product.name)}"></label></article>`).join('') : '<p class="ops-empty">Nenhum produto disponível.</p>'}
    <p class="ops-total" id="cart-subtotal">Subtotal dos produtos: ${price(0)}</p><p><small>O servidor confere preços e disponibilidade ao receber o pedido. Frete: valor a combinar.</small></p>${destinationFields()}<label class="field"><span>Observações (opcional)</span><textarea name="note" maxlength="1000"></textarea></label>${mapFields(['dropoff'])}${paymentField()}<button class="primary" type="submit" data-locked="${!store.is_open || !store.products?.length}" ${!store.is_open || !store.products?.length ? 'disabled' : ''}>Confirmar pedido</button></form>`;
}
function renderManage(store: Store | null) {
  main.innerHTML = `<h1>Minha loja</h1><p>Você gerencia somente o estabelecimento vinculado à sua conta.</p><form class="card ops-form" id="store-form"><label class="field"><span>Categoria</span><select name="category">${services.filter(service => service.commerce).map(service => `<option value="${service.id}" ${store?.category === service.id ? 'selected' : ''}>${service.name}</option>`).join('')}</select></label>${field('name', 'Nome da loja', store?.name ?? '', 2, 100)}
    <label class="field"><span>Descrição</span><textarea name="description" maxlength="1000">${esc(store?.description ?? '')}</textarea></label><div class="ops-two-fields">${field('pickupAddress', 'Endereço completo de retirada', store?.pickup_address ?? '', 5, 400)}${field('pickupArea', 'Bairro / área publicada', store?.pickup_area ?? '', 2, 100)}</div>${mapFields(['pickup'])}
    <label class="ops-check"><input name="isOpen" type="checkbox" ${store?.is_open ? 'checked' : ''}>Loja aberta para receber pedidos</label><label class="ops-check"><input name="isPublished" type="checkbox" ${store?.is_published ? 'checked' : ''}>Publicar a loja e os produtos no catálogo</label><div class="note">Nome, descrição, área e produtos publicados ficam visíveis no catálogo. Endereço exato e coordenadas são liberados somente aos participantes de um pedido. Farmácia oferece retirada/entrega, sem dispensação automatizada.</div><button class="primary" type="submit">Salvar loja</button></form>
    ${store ? `<section class="ops-history"><h2>Seus produtos</h2><div class="card">${store.products?.length ? store.products.map(product => `<article class="ops-product"><div><h3>${esc(product.name)}</h3><p>${esc(product.description)}</p><strong>${price(product.price_cents)}</strong><small>${product.is_available ? 'Disponível' : 'Indisponível'}</small></div><div class="ops-row"><button class="secondary" type="button" data-product-edit="${esc(product.id)}">Editar</button><button class="secondary" type="button" data-product-toggle="${esc(product.id)}">${product.is_available ? 'Pausar' : 'Disponibilizar'}</button></div></article>`).join('') : '<p>Nenhum produto cadastrado.</p>'}</div></section><form class="card ops-form ops-history" id="product-form"><h2 id="product-title">Adicionar produto</h2><input type="hidden" name="productId">${field('name', 'Nome do produto', '', 2, 100)}<label class="field"><span>Descrição</span><textarea name="description" maxlength="1000"></textarea></label><label class="field"><span>Preço em reais</span><input name="price" type="number" min="0" max="100000" step="0.01" required></label><label class="ops-check"><input name="isAvailable" type="checkbox" checked>Disponível para pedido</label><button class="primary" type="submit">Salvar produto</button><button class="secondary" type="button" data-product-new>Novo produto</button></form>` : '<div class="note">Salve sua loja para cadastrar produtos.</div>'}`;
}
function renderOrder(order: Order) {
  const container = document.getElementById('order-live');
  if (!container) return;
  const previousCodeInput = container.querySelector<HTMLInputElement>('[name=deliveryCode]');
  const enteredCode = previousCodeInput?.value ?? '';
  const restoreCodeFocus = document.activeElement === previousCodeInput;
  const code = privateCode?.orderId === order.id ? privateCode : null;
  container.innerHTML = `<button class="secondary ops-back" type="button" data-nav="orders">Voltar aos pedidos</button><span class="eyebrow">${esc(serviceName(order.service))}</span><h1>Seu pedido</h1><p>${esc(order.id)}</p><span class="ops-status ${terminal(order) ? 'terminal' : ''}">${esc(statuses[order.status] ?? order.status)}</span>
    <section class="card ops-history"><h2>Origem e destino</h2><p class="ops-detail-address"><strong>Origem:</strong> ${esc(order.pickupAddress)} · ${esc(order.pickupArea)}</p><p class="ops-detail-address"><strong>Destino:</strong> ${esc(order.dropoffAddress)} · ${esc(order.dropoffArea)}</p>${order.storeName ? `<p>Loja: ${esc(order.storeName)}</p>` : ''}${order.deliveryType ? `<p>Tipo: ${esc(order.deliveryType)}</p>` : ''}${order.note ? `<p>Observações: ${esc(order.note)}</p>` : ''}
    ${order.items?.length ? `<h3>Produtos do pedido</h3>${order.items.map(item => `<p>${item.quantity} × ${esc(item.name)} · ${price(item.lineTotalCents)}</p>`).join('')}` : ''}<p>${order.subtotalCents != null ? 'Produtos: ' + price(order.subtotalCents) + '. ' : ''}Frete / corrida: <strong>valor a combinar</strong>.</p><div class="note">Pagamento simulado, sem cobrança. Não há Pix, cartão, saldo ou saque real neste aplicativo.</div>
    <div class="ops-actions">${(order.availableActions ?? []).filter(action => action !== 'complete').map(action => `<button class="${action === 'cancel' || action === 'reject' ? 'secondary' : 'primary'}" type="button" data-order-action="${esc(action)}">${esc(actions[action] ?? action)}</button>`).join('')}</div>
    ${order.availableActions?.includes('complete') ? '<form id="complete-form" class="ops-form ops-history"><label class="field"><span>Código de conclusão informado pelo cliente</span><input name="deliveryCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></label><button class="primary" type="submit">Confirmar conclusão</button></form>' : ''}
    ${order.canGenerateDeliveryCode ? '<button class="secondary ops-history" type="button" data-delivery-code>Gerar novo código de conclusão</button><p><small>Mostre o código somente ao profissional quando o serviço estiver concluído. Um novo código invalida o anterior.</small></p>' : ''}
    ${code ? `<div class="note"><strong>Seu código: ${esc(code.value)}</strong><p>Válido até ${date(code.expiresAt)}. Ele não será mostrado novamente após sair desta tela; gere outro se precisar.</p></div>` : ''}</section>
    <section class="card ops-history"><h2>Localização compartilhada</h2>${order.latestLocation ? `<div class="ops-coordinate"><p>Latitude ${order.latestLocation.latitude.toFixed(5)} · longitude ${order.latestLocation.longitude.toFixed(5)}</p><p>Precisão informada pelo navegador: ${Math.round(order.latestLocation.accuracy)} m · ${date(order.latestLocation.updatedAt)}</p><p>${order.latestLocation.stale ? 'Posição desatualizada; não representa a localização atual.' : 'Última posição enviada pelo profissional. Pode não ser a posição atual.'}</p></div>` : '<p>Nenhuma posição compartilhada para este pedido.</p>'}
    ${order.canShareLocation ? `<p><small>Opcional: compartilhe o GPS deste navegador somente com os participantes deste pedido ativo. Ao sair desta tela ou encerrar o serviço, o compartilhamento é interrompido.</small></p><button class="secondary" type="button" ${trackingOrderId ? 'data-stop-location' : 'data-share-location'}>${trackingOrderId ? 'Parar de compartilhar e remover a última posição' : 'Compartilhar minha localização com os participantes'}</button>` : ''}<p><small>Rota, mapa de percurso e previsão de chegada não configurados. O mapa opcional abaixo mostra somente o último ponto enviado.</small></p></section>
    <section class="card ops-history"><h2>Histórico de etapas</h2><ol class="ops-timeline">${(order.history ?? []).map(item => `<li>${esc(statuses[item.status] ?? item.status)} · ${esc(roles[item.actorRole as Role] ?? item.actorRole)}<time>${date(item.at)}</time></li>`).join('')}</ol></section>`;
  disablePending(pending);
  const newCodeInput = container.querySelector<HTMLInputElement>('[name=deliveryCode]');
  if (newCodeInput && enteredCode) { newCodeInput.value = enteredCode; if (restoreCodeFocus) newCodeInput.focus(); }
}
function pinPayload(kind: 'pickup' | 'dropoff') {
  const point = pins[kind];
  return point ? { [`${kind}Latitude`]: point.lat, [`${kind}Longitude`]: point.lng } : {};
}
function formValues(form: HTMLFormElement) { return new FormData(form); }
function setPin(kind: 'pickup' | 'dropoff', point: MapPoint, detail = '') {
  pins[kind] = point;
  const summary = document.getElementById('pin-' + kind);
  if (summary) summary.textContent = `${kind === 'pickup' ? 'Origem' : 'Destino'}: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}${detail}`;
  mapController?.setPoint(point);
}
async function openMap(detail = false) {
  if (mapController || mapLoadingRevision === revision) return;
  const version = revision;
  mapLoadingRevision = version;
  try {
  const container = document.getElementById(detail ? 'ops-detail-map' : 'ops-form-map')!;
  container.hidden = false;
  const config = await api<{ tileUrl?: string }>('/api/map-config');
  if (version !== revision) return;
  const instance = await mountMap(container, {
    tileUrl: config.tileUrl,
    ...(detail ? {} : { onPick: (point: MapPoint) => {
      if (version !== revision) return;
      const kind = (main.querySelector<HTMLInputElement>('input[name=mapTarget]:checked')?.value ?? 'dropoff') as 'pickup' | 'dropoff';
      setPin(kind, point, ' · pino manual; endereço não verificado');
    } }),
    onError: (text: string) => { if (version === revision) message(text); },
  });
  if (version !== revision) { instance.destroy(); return; }
  mapController = instance;
  if (detail && selectedOrder?.latestLocation && !selectedOrder.latestLocation.stale) {
    instance.setTrackedPoint({ lat: selectedOrder.latestLocation.latitude, lng: selectedOrder.latestLocation.longitude });
  }
  } finally { if (mapLoadingRevision === version) mapLoadingRevision = null; }
}
async function useLocation(kind: 'pickup' | 'dropoff') {
  const version = revision;
  try {
    const location = await getCurrentPosition();
    if (version !== revision) return;
    setPin(kind, location.point, ` · precisão ${Math.round(location.accuracy)} m, ${new Date(location.timestamp).toLocaleTimeString('pt-BR')}; endereço não verificado`);
    mapController?.setCenter(location.point);
  } catch (error) { if (version === revision) failure(error); }
}
async function stopSharing(remove = true) {
  const orderId = trackingOrderId;
  const version = revision;
  const owner = profile?.user_id;
  trackingRevision++;
  if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
  watchId = null; trackingOrderId = null;
  if (!orderId || !remove) return;
  await locationWrites.catch(() => {});
  if (version !== revision || owner !== profile?.user_id) return;
  try { await mutate('/api/orders/' + encodeURIComponent(orderId) + '/location', {}, 'DELETE'); }
  catch (error) {
    if (version !== revision) return;
    if (error instanceof SessionChangedError || error instanceof ApiError && error.status === 401) { failure(error); return; }
    message('O GPS foi interrompido, mas não foi possível confirmar a remoção da última posição. ' + (error as Error).message);
  }
}
function startSharing() {
  const order = selectedOrder;
  if (!order?.canShareLocation || watchId !== null) return;
  if (!window.isSecureContext && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('GPS exige HTTPS ou localhost. Nenhuma localização foi enviada.');
  if (!navigator.geolocation) throw new Error('Este navegador não oferece geolocalização.');
  const consent = ++trackingRevision;
  trackingOrderId = order.id;
  lastLocationSent = 0;
  watchId = navigator.geolocation.watchPosition(position => {
    if (consent !== trackingRevision || trackingOrderId !== order.id || Date.now() - lastLocationSent < 5000) return;
    const { latitude, longitude, accuracy } = position.coords;
    const age = Date.now() - position.timestamp;
    if (!Number.isFinite(position.timestamp) || position.timestamp <= 0 || age > 120000 || age < -5000
      || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180
      || !Number.isFinite(accuracy) || accuracy < 0) {
      message('Posição inválida ou desatualizada: ela não foi enviada. Aguarde uma nova leitura do GPS.');
      return;
    }
    lastLocationSent = Date.now();
    const payload = { latitude, longitude, accuracy };
    locationWrites = locationWrites.catch(() => {}).then(async () => {
      if (consent !== trackingRevision) return;
      await mutate('/api/orders/' + encodeURIComponent(order.id) + '/location', payload);
      if (consent === trackingRevision) { message('Localização compartilhada somente com os participantes deste pedido.'); void refresh(); }
    }).catch(error => { if (consent === trackingRevision) failure(error); });
  }, error => {
    if (consent !== trackingRevision) return;
    void stopSharing();
    message(error.code === 1 ? 'Permissão de localização negada. Nenhuma posição nova será enviada.' : 'Não foi possível obter uma posição confiável. O compartilhamento foi interrompido.');
    if (selectedOrder) renderOrder(selectedOrder);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  message('GPS ativado para este pedido. Você pode interromper o compartilhamento a qualquer momento.');
  renderOrder(order);
}
async function perform(operation: (isCurrent: () => boolean) => Promise<void>) {
  if (pending || !profile) return;
  const version = revision;
  const id = ++operationId;
  readController?.abort();
  disablePending(true); message();
  try {
    if (!await verifyIdentity() || version !== revision || id !== operationId) return;
    await operation(() => version === revision && id === operationId);
  }
  catch (error) { if (version === revision) failure(error); }
  finally { if (id === operationId) disablePending(false); }
}
main.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  void perform(async isCurrent => {
    const data = formValues(form);
    if (form.id === 'order-form' || form.id === 'commerce-form') {
      const commerce = form.id === 'commerce-form';
      const payload: Record<string, unknown> = { service: commerce ? selectedStore!.category : view.service, requestId, dropoffAddress: data.get('dropoffAddress'), dropoffArea: data.get('dropoffArea'), note: data.get('note') ?? '', ...pinPayload('dropoff') };
      if (commerce) {
        payload.storeId = selectedStore!.id;
        payload.items = Array.from(form.querySelectorAll<HTMLInputElement>('[data-quantity]')).filter(input => Number(input.value) > 0).map(input => ({ productId: input.dataset.quantity!, quantity: Number(input.value) }));
        if (!(payload.items as unknown[]).length) throw new Error('Escolha ao menos um produto.');
      } else {
        Object.assign(payload, { pickupAddress: data.get('pickupAddress'), pickupArea: data.get('pickupArea'), ...pinPayload('pickup') });
        if (view.service === 'delivery') payload.deliveryType = data.get('deliveryType');
      }
      const result = await mutate<{ order: Order }>('/api/orders', payload);
      if (!isCurrent()) return;
      disablePending(false);
      await navigate({ kind: 'order', id: result.order.id });
    } else if (form.id === 'store-form') {
      const payload = { category: data.get('category'), name: data.get('name'), description: data.get('description'), pickupAddress: data.get('pickupAddress'), pickupArea: data.get('pickupArea'), isOpen: data.has('isOpen'), isPublished: data.has('isPublished'), ...pinPayload('pickup'), ...(!pins.pickup && selectedStore?.pickup_latitude != null ? { pickupLatitude: null, pickupLongitude: null } : {}) };
      await mutate('/api/store', payload, 'PUT');
      if (!isCurrent()) return;
      disablePending(false); await navigate({ kind: 'manage' }); message('Loja salva.');
    } else if (form.id === 'product-form') {
      const value = Number(data.get('price'));
      if (!Number.isFinite(value)) throw new Error('Informe um preço válido.');
      const payload = { name: data.get('name'), description: data.get('description'), priceCents: Math.round(value * 100), isAvailable: data.has('isAvailable') };
      const productId = String(data.get('productId') ?? '');
      await mutate('/api/store/products' + (productId ? '/' + encodeURIComponent(productId) : ''), payload, productId ? 'PATCH' : 'POST');
      if (!isCurrent()) return;
      disablePending(false); await navigate({ kind: 'manage' }); message('Produto salvo.');
    } else if (form.id === 'complete-form') {
      const value = String(data.get('deliveryCode'));
      (form.elements.namedItem('deliveryCode') as HTMLInputElement).value = '';
      await mutate('/api/orders/' + encodeURIComponent(selectedOrder!.id) + '/transition', { action: 'complete', expectedVersion: selectedOrder!.version, deliveryCode: value });
      if (!isCurrent()) return;
      disablePending(false); await refresh();
    }
  });
});
main.addEventListener('input', event => {
  if (!(event.target instanceof HTMLInputElement) || !event.target.dataset.quantity || !selectedStore) return;
  const total = Array.from(main.querySelectorAll<HTMLInputElement>('[data-quantity]')).reduce((sum, input) => sum + (selectedStore!.products?.find(product => product.id === input.dataset.quantity)?.price_cents ?? 0) * Math.max(0, Number(input.value) || 0), 0);
  document.getElementById('cart-subtotal')!.textContent = 'Subtotal dos produtos: ' + price(total);
});
document.addEventListener('click', event => {
  const button = (event.target as Element | null)?.closest<HTMLElement>('button,a[data-nav]');
  if (!button) return;
  if (pending && !button.hasAttribute('data-stop-location')) { event.preventDefault(); return; }
  if (button.dataset.nav) { event.preventDefault(); void navigate({ kind: button.dataset.nav as View['kind'] }); return; }
  if (button.dataset.service) { void navigate({ kind: 'service', service: button.dataset.service as Service }); return; }
  if (button.dataset.store) { void navigate({ kind: 'store', id: button.dataset.store }); return; }
  if (button.dataset.order) { void navigate({ kind: 'order', id: button.dataset.order }); return; }
  if (button.hasAttribute('data-open-map') || button.hasAttribute('data-detail-map')) { const version = revision; void openMap(button.hasAttribute('data-detail-map')).catch(error => { if (version === revision) failure(error); }); return; }
  if (button.dataset.useLocation) { void useLocation(button.dataset.useLocation as 'pickup' | 'dropoff').catch(failure); return; }
  if (button.hasAttribute('data-clear-pins')) { pins = {}; mapController?.setPoint(null); main.querySelectorAll<HTMLElement>('[id^=pin-]').forEach(element => { element.textContent = 'Sem coordenadas selecionadas; o endereço digitado continua necessário.'; }); return; }
  if (button.hasAttribute('data-share-location')) { void perform(async isCurrent => { if (isCurrent()) startSharing(); }); return; }
  if (button.hasAttribute('data-stop-location')) { const version = revision; void stopSharing().then(() => { if (version === revision && selectedOrder) renderOrder(selectedOrder); }); return; }
  if (button.dataset.productEdit) {
    const product = selectedStore?.products?.find(item => item.id === button.dataset.productEdit);
    const form = document.getElementById('product-form') as HTMLFormElement;
    if (!product || !form) return;
    for (const [key, value] of Object.entries({ productId: product.id, name: product.name, description: product.description, price: (product.price_cents / 100).toFixed(2) })) (form.elements.namedItem(key) as HTMLInputElement).value = value;
    (form.elements.namedItem('isAvailable') as HTMLInputElement).checked = product.is_available;
    document.getElementById('product-title')!.textContent = 'Editar produto'; form.scrollIntoView({ block: 'nearest' }); return;
  }
  if (button.hasAttribute('data-product-new')) { (document.getElementById('product-form') as HTMLFormElement).reset(); (document.querySelector('[name=productId]') as HTMLInputElement).value = ''; document.getElementById('product-title')!.textContent = 'Adicionar produto'; return; }
  if (button.dataset.accept) {
    void perform(async isCurrent => { const result = await mutate<{ order: Order }>('/api/orders/' + encodeURIComponent(button.dataset.accept!) + '/accept', { expectedVersion: Number(button.dataset.version) }); if (!isCurrent()) return; disablePending(false); await navigate({ kind: 'order', id: result.order.id }); }); return;
  }
  if (button.dataset.orderAction && selectedOrder) {
    const order = selectedOrder;
    void perform(async isCurrent => { await mutate('/api/orders/' + encodeURIComponent(order.id) + '/transition', { action: button.dataset.orderAction, expectedVersion: order.version }); if (!isCurrent()) return; disablePending(false); await refresh(); }); return;
  }
  if (button.hasAttribute('data-delivery-code') && selectedOrder) {
    const order = selectedOrder;
    void perform(async isCurrent => { const code = await mutate<{ deliveryCode: string; expiresAt: string }>('/api/orders/' + encodeURIComponent(order.id) + '/delivery-code', {}); if (!isCurrent() || selectedOrder?.id !== order.id) return; privateCode = { orderId: order.id, value: code.deliveryCode, expiresAt: code.expiresAt }; renderOrder(selectedOrder); }); return;
  }
  if (button.dataset.productToggle) {
    const product = selectedStore?.products?.find(item => item.id === button.dataset.productToggle);
    if (product) void perform(async isCurrent => { await mutate('/api/store/products/' + encodeURIComponent(product.id), { isAvailable: !product.is_available }, 'PATCH'); if (!isCurrent()) return; disablePending(false); await navigate({ kind: 'manage' }); });
  }
});
document.getElementById('ops-refresh')!.addEventListener('click', () => { void refresh(); });
logoutButton.addEventListener('click', () => {
  if (pending) return;
  const owner = profile?.user_id;
  void perform(async isCurrent => {
    await stopSharing();
    if (!isCurrent() || profile?.user_id !== owner) return;
    await mutate('/api/auth/logout', {});
    if (!isCurrent()) return;
    try { sessionChannel?.postMessage({ type: 'changed' }); } catch { /* Other tabs also recheck their session by polling and focus. */ }
    signedOut();
  });
});
window.addEventListener('pagehide', () => {
  const orderId = trackingOrderId;
  const lastWrites = locationWrites;
  void stopSharing(false);
  destroyMap();
  clearInterval(interval);
  interval = undefined;
  revision++;
  operationId++;
  const version = revision;
  readController?.abort();
  // Best effort on page close; a DELETE must not overtake an already-sent GPS write.
  if (orderId) void lastWrites.catch(() => {}).then(() => { if (version === revision) return mutate('/api/orders/' + encodeURIComponent(orderId) + '/location', {}, 'DELETE', true); }).catch(() => {});
});
window.addEventListener('pageshow', event => { if (event.persisted) void initialize(); });
window.addEventListener('focus', () => { if (!document.hidden) void refresh(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { void refresh(); return; }
  // Stop background tracking without discarding a draft or a pending, explicitly requested GPS pin.
  const version = revision;
  void stopSharing().then(() => { if (version === revision && selectedOrder) renderOrder(selectedOrder); });
});
try {
  sessionChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('titoja-session') : null;
  sessionChannel?.addEventListener('message', event => { if (event.data?.type === 'changed') void initialize(); });
} catch { /* Polling, focus and visibility still revalidate when channels are unavailable. */ }
async function initialize() {
  clearPrivateState();
  main.innerHTML = '<section class="card"><h1>Conferindo sua conta.</h1></section>';
  const version = revision;
  const controller = new AbortController();
  readController = controller;
  if (!interval) interval = setInterval(() => { void refresh(); }, 5000);
  try {
    const data = await api<{ profile: Profile }>('/api/account', { signal: controller.signal });
    if (version !== revision) return;
    showProfile(checkedProfile(data.profile));
    await navigate({ kind: 'home' });
  } catch (error) { if (version === revision) failure(error); }
}
void initialize();
