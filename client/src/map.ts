import type {CircleMarker, LeafletMouseEvent, Map as LeafletMap, Marker} from 'leaflet';

export interface MapPoint {lat: number; lng: number}
export interface LocationResult {point: MapPoint; accuracy: number; timestamp: number}
export interface MapOptions {
  /** Call mountMap only after the user explicitly chooses to load external map tiles. */
  onPick?: (point: MapPoint) => void;
  initialPoint?: MapPoint;
  tileUrl?: string;
  onError?: (message: string) => void;
}
export interface MapController {
  setPoint(point: MapPoint | null): void;
  setCenter(point: MapPoint, zoom?: number): void;
  /** Display only an actual coordinate supplied by the application; never invent a position. */
  setTrackedPoint(point: MapPoint | null): void;
  invalidateSize(): void;
  destroy(): void;
}

export const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MAX_MERCATOR_LATITUDE = 85.05112878;
const activeMaps = new WeakMap<HTMLElement, MapController>();
const pendingMaps = new WeakSet<HTMLElement>();
let leafletPromise: Promise<typeof import('leaflet')> | undefined;
let stylesheetPromise: Promise<void> | undefined;
let nextMapId = 0;

export function isMapPoint(value: unknown): value is MapPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<MapPoint>;
  return typeof point.lat === 'number' && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && typeof point.lng === 'number' && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

function checkedPoint(point: MapPoint): MapPoint {
  if (!isMapPoint(point)) throw new Error('Coordenadas inválidas. Informe latitude e longitude válidas.');
  return {lat: point.lat, lng: point.lng};
}

/** HTTPS tile templates only. No geocoding, routing, proxying or tile prefetch is performed. */
export function validateTileUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 2048 || !['{z}', '{x}', '{y}'].every(part => value.includes(part))) {
    throw new Error('O endereço do provedor de mapas não está configurado corretamente.');
  }
  let parsed: URL;
  try { parsed = new URL(value.replace(/\{[a-z]+\}/gi, '0')); }
  catch { throw new Error('O endereço do provedor de mapas não é válido.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash
    || /\{(?!z\}|x\}|y\}|s\}|r\})[^}]*\}/i.test(value)) {
    throw new Error('O provedor de mapas deve usar HTTPS e não pode conter credenciais.');
  }
  return value;
}

function loadLeafletStyles(doc: Document): Promise<void> {
  if (stylesheetPromise) return stylesheetPromise;
  stylesheetPromise = new Promise<void>((resolve, reject) => {
    const existing = doc.querySelector<HTMLLinkElement>('link[data-titoja-leaflet]');
    if (existing?.sheet) { resolve(); return; }
    const link = existing ?? doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/vendor/leaflet.css';
    link.dataset.titojaLeaflet = 'true';
    const timer = setTimeout(() => finish(new Error('Os controles do mapa não puderam ser carregados.')), 15000);
    const loaded = () => finish();
    const failed = () => finish(new Error('Os controles do mapa não puderam ser carregados.'));
    function finish(error?: Error) {
      clearTimeout(timer);
      link.removeEventListener('load', loaded);
      link.removeEventListener('error', failed);
      if (error) { link.remove(); reject(error); } else resolve();
    }
    link.addEventListener('load', loaded, {once: true});
    link.addEventListener('error', failed, {once: true});
    if (!existing) doc.head.append(link);
  }).catch(error => { stylesheetPromise = undefined; throw error; });
  return stylesheetPromise;
}

async function loadLeaflet(doc: Document): Promise<typeof import('leaflet')> {
  if (!leafletPromise) {
    // A variable URL keeps the emitted browser module free of unresolved bare npm imports.
    const moduleUrl = new URL('/vendor/leaflet.js', doc.baseURI).href;
    leafletPromise = import(moduleUrl).then(module => module as typeof import('leaflet'))
      .catch(error => { leafletPromise = undefined; throw error; });
  }
  const [module] = await Promise.all([leafletPromise, loadLeafletStyles(doc)]);
  return module;
}

/**
 * Opens the map after an explicit user action. Loading this module alone requests no tiles,
 * geolocation, routes or external assets. A selected point is not a verified street address.
 */
export async function mountMap(container: HTMLElement, options: MapOptions = {}): Promise<MapController> {
  if (!container?.ownerDocument) throw new Error('O espaço do mapa não está disponível.');
  if (pendingMaps.has(container)) throw new Error('Aguarde o carregamento deste mapa.');
  const tileUrl = validateTileUrl(options.tileUrl ?? DEFAULT_TILE_URL);
  const initialPoint = options.initialPoint ? checkedPoint(options.initialPoint) : null;
  activeMaps.get(container)?.destroy();
  pendingMaps.add(container);
  container.classList.add('titoja-map');
  const doc = container.ownerDocument;
  const status = doc.createElement('p');
  status.className = 'titoja-map-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Carregando mapa…';
  container.replaceChildren(status);
  let map: LeafletMap | undefined;
  try {
    const L = await loadLeaflet(doc);
    if (!container.isConnected) throw new Error('O espaço do mapa já foi fechado.');
    const mapId = `titoja-map-${++nextMapId}`;
    const hint = doc.createElement('p');
    hint.id = `${mapId}-hint`;
    hint.className = 'titoja-map-hint';
    hint.textContent = options.onPick
      ? 'Clique para escolher um ponto. Pelo teclado, mova o mapa com as setas e use “Selecionar centro do mapa”. O ponto não confirma um endereço.'
      : 'Mapa de coordenadas informadas. Use as setas e os controles para navegar. Sem cálculo de rota ou previsão de chegada.';
    const stage = doc.createElement('div');
    stage.className = 'titoja-map-stage';
    stage.id = mapId;
    stage.setAttribute('role', 'region');
    stage.setAttribute('aria-label', 'Mapa OpenStreetMap');
    stage.setAttribute('aria-describedby', hint.id);
    stage.tabIndex = 0;
    const toolbar = doc.createElement('div');
    toolbar.className = 'titoja-map-toolbar';
    const pointText = doc.createElement('p');
    pointText.className = 'titoja-map-point';
    pointText.setAttribute('aria-live', 'polite');
    pointText.textContent = 'Nenhum ponto selecionado. A visão inicial é do mapa-múndi.';
    const privacy = doc.createElement('p');
    privacy.className = 'titoja-map-privacy';
    privacy.textContent = 'O provedor dos mapas recebe seu IP, a origem deste site e a área visualizada. Não enviamos nomes, endereços de texto ou dados de pedidos. Sem rota ou estimativa de chegada.';
    status.textContent = '';
    status.hidden = true;
    container.replaceChildren(hint, stage, toolbar, pointText, status, privacy);
    map = L.map(stage, {
      keyboard: true, scrollWheelZoom: false, zoomControl: false, attributionControl: true,
      minZoom: 2, maxZoom: 19, maxBounds: [[-MAX_MERCATOR_LATITUDE, -180], [MAX_MERCATOR_LATITUDE, 180]],
      maxBoundsViscosity: 1, zoomAnimation: false, fadeAnimation: false,
    });
    const leafletMap = map;
    leafletMap.setView(initialPoint ? [initialPoint.lat, initialPoint.lng] : [0, 0], initialPoint ? 15 : 2);
    L.control.zoom({zoomInTitle: 'Aproximar mapa', zoomOutTitle: 'Afastar mapa'}).addTo(leafletMap);
    let tileErrorShown = false;
    const tiles = L.tileLayer(tileUrl, {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
      minZoom: 2, maxZoom: 19, noWrap: true, keepBuffer: 0, updateWhenIdle: true,
      updateWhenZooming: false, detectRetina: false, referrerPolicy: 'strict-origin-when-cross-origin',
    });
    tiles.on('tileerror', () => {
      if (tileErrorShown) return;
      tileErrorShown = true;
      status.hidden = false;
      status.classList.add('is-error');
      status.textContent = 'O mapa-base está indisponível ou incompleto. Ainda é possível selecionar coordenadas, mas isso não confirma o endereço. Tente novamente mais tarde.';
      options.onError?.(status.textContent);
    });
    tiles.addTo(leafletMap);
    let marker: Marker | undefined;
    let trackedMarker: CircleMarker | undefined;
    let destroyed = false;
    const pinIcon = L.icon({
      iconUrl: '/vendor/images/marker-icon.png', iconRetinaUrl: '/vendor/images/marker-icon-2x.png',
      shadowUrl: '/vendor/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41],
      shadowSize: [41, 41], tooltipAnchor: [16, -28],
    });
    const setPoint = (value: MapPoint | null) => {
      if (destroyed) return;
      if (value === null) {
        marker?.remove(); marker = undefined;
        pointText.textContent = 'Nenhum ponto selecionado.';
        return;
      }
      const point = checkedPoint(value);
      if (marker) marker.setLatLng([point.lat, point.lng]);
      else {
        marker = L.marker([point.lat, point.lng], {
          icon: pinIcon, draggable: Boolean(options.onPick), keyboard: true,
          title: 'Ponto selecionado no mapa; endereço não verificado', alt: 'Ponto selecionado no mapa',
        }).addTo(leafletMap);
        if (options.onPick) marker.on('dragend', () => pick(marker!.getLatLng().wrap()));
      }
      pointText.textContent = `Ponto selecionado: ${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}. Endereço não verificado.`;
    };
    const pick = (value: MapPoint) => {
      if (destroyed || !options.onPick) return;
      const point = checkedPoint(value);
      setPoint(point);
      options.onPick({...point});
    };
    const handleClick = (event: LeafletMouseEvent) => pick(event.latlng.wrap());
    if (options.onPick) {
      leafletMap.on('click', handleClick);
      const chooseCenter = doc.createElement('button');
      chooseCenter.type = 'button';
      chooseCenter.className = 'titoja-map-button';
      chooseCenter.textContent = 'Selecionar centro do mapa';
      chooseCenter.addEventListener('click', () => pick(leafletMap.getCenter().wrap()));
      toolbar.append(chooseCenter);
    }
    const issueLink = doc.createElement('a');
    issueLink.href = 'https://www.openstreetmap.org/fixthemap';
    issueLink.target = '_blank';
    issueLink.rel = 'noopener noreferrer';
    issueLink.textContent = 'Informar problema no mapa';
    toolbar.append(issueLink);
    const controller: MapController = {
      setPoint,
      setCenter(value, zoom = 15) {
        if (destroyed) return;
        const point = checkedPoint(value);
        if (!Number.isFinite(zoom) || zoom < 2 || zoom > 19) throw new Error('O nível de zoom do mapa é inválido.');
        leafletMap.setView([point.lat, point.lng], zoom, {animate: false});
      },
      setTrackedPoint(value) {
        if (destroyed) return;
        if (value === null) { trackedMarker?.remove(); trackedMarker = undefined; return; }
        const point = checkedPoint(value);
        if (trackedMarker) trackedMarker.setLatLng([point.lat, point.lng]);
        else trackedMarker = L.circleMarker([point.lat, point.lng], {
          radius: 8, color: '#ffffff', weight: 3, fillColor: '#1564b4', fillOpacity: 1,
        }).addTo(leafletMap).bindTooltip('Última coordenada informada pelo profissional');
      },
      invalidateSize() { if (!destroyed) leafletMap.invalidateSize({animate: false}); },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        leafletMap.remove();
        container.replaceChildren();
        container.classList.remove('titoja-map');
        activeMaps.delete(container);
      },
    };
    activeMaps.set(container, controller);
    if (initialPoint) setPoint(initialPoint);
    return controller;
  } catch {
    map?.remove();
    const message = 'Não foi possível abrir o mapa. Você pode continuar informando o endereço e as coordenadas sem ele.';
    status.hidden = false;
    status.classList.add('is-error');
    status.textContent = message;
    container.replaceChildren(status);
    options.onError?.(message);
    throw new Error(message);
  } finally { pendingMaps.delete(container); }
}

export type LocationErrorCode = 'unsupported' | 'insecure' | 'denied' | 'timeout' | 'unavailable' | 'invalid' | 'stale';
export class LocationError extends Error {
  constructor(public readonly code: LocationErrorCode, message: string) { super(message); this.name = 'LocationError'; }
}

/** Only call after a separate, explicit request to use this device's location. No tracking is started. */
export function getCurrentPosition(options: PositionOptions = {}): Promise<LocationResult> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.reject(new LocationError('unsupported', 'Este navegador não oferece localização. Escolha um ponto manualmente.'));
  }
  if (typeof isSecureContext === 'boolean' && !isSecureContext) {
    return Promise.reject(new LocationError('insecure', 'A localização exige uma conexão HTTPS. Escolha um ponto manualmente.'));
  }
  const config: PositionOptions = {enableHighAccuracy: true, timeout: 15000, maximumAge: 0, ...options};
  return new Promise<LocationResult>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(position => {
      const point = {lat: position.coords.latitude, lng: position.coords.longitude};
      if (!isMapPoint(point) || !Number.isFinite(position.coords.accuracy) || position.coords.accuracy < 0
        || !Number.isFinite(position.timestamp) || position.timestamp <= 0) {
        reject(new LocationError('invalid', 'O dispositivo não informou uma localização válida. Escolha um ponto manualmente.'));
        return;
      }
      const age = Date.now() - position.timestamp;
      if (age > Math.max(config.maximumAge ?? 0, 30000) || age < -300000) {
        reject(new LocationError('stale', 'A localização recebida está desatualizada. Tente novamente ou escolha um ponto manualmente.'));
        return;
      }
      resolve({point, accuracy: position.coords.accuracy, timestamp: position.timestamp});
    }, error => {
      const code: LocationErrorCode = error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : 'unavailable';
      const message = code === 'denied' ? 'A permissão de localização foi recusada. Você pode escolher um ponto manualmente.'
        : code === 'timeout' ? 'A localização demorou para responder. Tente novamente ou escolha um ponto manualmente.'
        : 'A localização não está disponível agora. Escolha um ponto manualmente.';
      reject(new LocationError(code, message));
    }, config);
  });
}
