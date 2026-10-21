import {visibleOrders} from './features.js';
import type {DemoState, FoodRole, MenuProduct, Order, OrderStatus, Role} from './types.js';
export const restaurant = {id:'tito-lanches-demo',name:'Lanchonete do Tito',operator:'Bia Demo',address:'Rua dos Sabores, 42 · Centro (fictício)',description:'Hambúrgueres caprichados e lanches para o seu dia',deliveryFee:8};
export const menu:MenuProduct[] = [
 {id:'x-tito',name:'X-Tito da casa',description:'Pão, hambúrguer, queijo, alface, tomate e molho da casa.',price:22,category:'Lanches',visual:'burger'},
 {id:'x-bacon',name:'X-Bacon',description:'Hambúrguer, queijo, bacon crocante e molho especial.',price:27,category:'Lanches',visual:'burger'},
 {id:'x-salada',name:'X-Salada',description:'Hambúrguer, queijo, alface e tomate no pão macio.',price:20,category:'Lanches',visual:'burger'},
 {id:'misto',name:'Misto quente',description:'Pão tostado com presunto e queijo derretido.',price:12,category:'Lanches',visual:'sandwich'},
 {id:'batata',name:'Batata crocante',description:'Porção individual de batatas fritas douradinhas.',price:14,category:'Acompanhamentos',visual:'fries'},
 {id:'refri',name:'Refrigerante lata',description:'Lata de 350 ml, sabor fictício da casa.',price:6,category:'Bebidas',visual:'drink'},
 {id:'suco',name:'Suco de laranja',description:'Copo de 300 ml para acompanhar seu lanche.',price:8,category:'Bebidas',visual:'juice'}
];
export const foodSteps:OrderStatus[]=['pendingAcceptance','restaurantAccepted','preparing','ready','assigned','pickingUp','foodCollected','outForDelivery','completed'];
const labels:Partial<Record<OrderStatus,string>>={pendingAcceptance:'Aguardando o restaurante',restaurantAccepted:'Aceito pelo restaurante',preparing:'Em preparo',ready:'Pronto · aguardando entregador',assigned:'Entregador aceitou',pickingUp:'Entregador a caminho da retirada',foodCollected:'Retirada confirmada',outForDelivery:'Saiu para entrega',completed:'Entregue',cancelled:'Cancelado'};
export function foodStatusLabel(status:OrderStatus){return labels[status]||status;}
export function normalizeFoodState(state:DemoState):DemoState {
 state.foodCart??=[];state.demoProfiles??={client:{name:state.name+' Demo',registered:false},restaurant:{name:restaurant.operator,registered:false},courier:{name:'Lia Demo',registered:false}};
 state.foodCart=state.foodCart.filter(x=>menu.some(p=>p.id===x.productId)&&Number.isInteger(x.quantity)&&x.quantity>0&&x.quantity<=20);return state;
}
export function requireGenericOrder(order:Order){if(order.food)throw Error('Use as etapas do pedido de comida.');}
export function cartItems(state:DemoState){return state.foodCart.map(line=>{const p=menu.find(p=>p.id===line.productId)!;return {productId:p.id,name:p.name,unitPrice:p.price,quantity:line.quantity,lineTotal:p.price*line.quantity};});}
export function cartSubtotal(state:DemoState){return cartItems(state).reduce((sum,x)=>sum+x.lineTotal,0);}
export function setCartQuantity(state:DemoState,productId:string,quantity:number){
 if(state.role!=='client')throw Error('Abra o perfil Cliente para montar o pedido.');
 if(!menu.some(p=>p.id===productId)||!Number.isInteger(quantity)||quantity<0||quantity>20)throw Error('Escolha de 1 a 20 unidades por produto.');
 const line=state.foodCart.find(x=>x.productId===productId);if(quantity===0)state.foodCart=state.foodCart.filter(x=>x.productId!==productId);else if(line)line.quantity=quantity;else state.foodCart.push({productId,quantity});
}
export function createFoodOrder(state:DemoState,to:string,note:string,paymentApproved:boolean):Order {
 if(state.role!=='client')throw Error('Somente o perfil Cliente pode confirmar o pedido.');
 if(!paymentApproved)throw Error('Confirme o pagamento fictício para continuar.');
 if(!state.foodCart.length)throw Error('Sua sacola está vazia. Adicione um lanche.');
 if(visibleOrders(state).some(o=>!['completed','cancelled'].includes(o.status)))throw Error('Finalize ou cancele seu pedido atual antes de fazer outro.');
 if(to.trim().length<5||to.length>100)throw Error('Informe um endereço fictício de entrega.');
 const now=new Date().toISOString(),items=cartItems(state),subtotal=cartSubtotal(state),total=subtotal+restaurant.deliveryFee;
 const nextId=Math.max(1024,...state.orders.map(o=>Number(o.id.replace('TJ-',''))||0))+1;
 const order:Order={id:`TJ-${nextId}`,service:'food',kind:'delivery',from:restaurant.address,to:to.trim(),note:note.trim().slice(0,180),deliveryType:'Comida',payment:'Pagamento fictício aprovado',status:'pendingAcceptance',created:now,price:total,distance:2,minutes:30,rejectedBy:[],food:{restaurantId:restaurant.id,restaurantName:restaurant.name,customerName:state.demoProfiles.client.name,restaurantOperator:state.demoProfiles.restaurant.name,items,subtotal,deliveryFee:restaurant.deliveryFee,total,paymentStatus:'approved',paymentApprovedAt:now,history:[{status:'pendingAcceptance',at:now,by:'client'}]}};
 state.orders.unshift(order);state.foodCart=[];return order;
}
export type FoodAction='restaurantAccept'|'startPreparing'|'markReady'|'courierAccept'|'goPickup'|'confirmPickup'|'startDelivery'|'deliver'|'cancel'|'restaurantReject';
const transitions:Record<Exclude<FoodAction,'cancel'|'restaurantReject'>,{from:OrderStatus;to:OrderStatus;role:Role}>={
 restaurantAccept:{from:'pendingAcceptance',to:'restaurantAccepted',role:'restaurant'},startPreparing:{from:'restaurantAccepted',to:'preparing',role:'restaurant'},markReady:{from:'preparing',to:'ready',role:'restaurant'},courierAccept:{from:'ready',to:'assigned',role:'courier'},goPickup:{from:'assigned',to:'pickingUp',role:'courier'},confirmPickup:{from:'pickingUp',to:'foodCollected',role:'courier'},startDelivery:{from:'foodCollected',to:'outForDelivery',role:'courier'},deliver:{from:'outForDelivery',to:'completed',role:'courier'}
};
export function transitionFood(state:DemoState,id:string,action:FoodAction,expected:OrderStatus):Order {
 const order=state.orders.find(o=>o.id===id);if(!order?.food)throw Error('Pedido de comida não encontrado.');
 if(order.status!==expected)throw Error('Esta etapa já foi atualizada. Confira o status do pedido.');
 let next:OrderStatus;
 if(action==='cancel'||action==='restaurantReject'){
   const role=action==='cancel'?'client':'restaurant';if(state.role!==role||order.status!=='pendingAcceptance')throw Error('Só é possível cancelar antes do aceite do restaurante.');next='cancelled';order.food.paymentStatus='cancelled';
 }else{
   const t=transitions[action];if(!t||state.role!==t.role||order.status!==t.from)throw Error('Esta ação não está disponível nesta etapa ou perfil.');
   if(action==='courierAccept'){
     if(!state.online.courier)throw Error('Fique disponível para aceitar a entrega.');
     if(visibleOrders(state).some(o=>o.professional==='courier'&&!['completed','cancelled'].includes(o.status)))throw Error('Finalize sua entrega atual primeiro.');
     order.professional='courier';order.food.courierName=state.demoProfiles.courier.name;
   }else if(t.role==='courier'&&order.professional!=='courier')throw Error('Este pedido não foi atribuído ao entregador.');
   next=t.to;
 }
 const at=new Date().toISOString();order.status=next;order.food.history.push({status:next,at,by:state.role});if(['completed','cancelled'].includes(next))order.finished=at;return order;
}
export function registerDemoProfile(state:DemoState,role:FoodRole,name:string){if(!['client','restaurant','courier'].includes(role)||name.trim().length<2||name.length>40)throw Error('Use um nome fictício entre 2 e 40 caracteres.');state.demoProfiles[role]={name:name.trim(),registered:true,registeredAt:new Date().toISOString()};if(role==='client')state.name=name.trim();}
export function foodCourierQueue(state:DemoState){return state.orders.filter(o=>o.food&&o.status==='ready'&&!o.rejectedBy?.includes('courier'));}
