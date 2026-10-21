import type {DemoState,Order,Role,ServiceId} from './types.js';
/** Temporary product focus. Set deliveryFocus=false to restore the preserved service UI. */
export const featureFlags={deliveryFocus:true};
const allServices:ServiceId[]=['moto','car','delivery','food','beer','pharmacy','documents'];
const allRoles:Role[]=['client','restaurant','courier','driver','admin'];
export function enabledServices():ServiceId[]{return featureFlags.deliveryFocus?['food','beer']:[...allServices]}
export function enabledRoles():Role[]{return featureFlags.deliveryFocus?['client','restaurant','courier','admin']:[...allRoles]}
export function serviceVisible(service:ServiceId){return enabledServices().includes(service)}
export function roleVisible(role:Role){return enabledRoles().includes(role)}
export function orderVisible(order:Order){return !featureFlags.deliveryFocus||serviceVisible(order.service)}
export function visibleOrders(state:DemoState){return state.orders.filter(orderVisible)}
export function visibleNotifications(state:DemoState){
 if(!featureFlags.deliveryFocus)return state.notifications;
 const hiddenOrders=state.orders.filter(o=>!orderVisible(o)),hiddenApplications=state.applications.filter(a=>a.type!=='Entregador');
 return state.notifications.filter(n=>!hiddenOrders.some(o=>n.text.includes(o.id))&&!hiddenApplications.some(a=>n.text.includes(a.name))&&!/corrida|motorista|mototáxi|documento|farmácia|cadastro profissional/i.test(n.text));
}
