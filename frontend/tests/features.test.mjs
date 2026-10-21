import test from 'node:test';import assert from 'node:assert/strict';
import {featureFlags,enabledServices,enabledRoles,visibleOrders,visibleNotifications} from '../dist/features.js';
import {initialState,createOrder,acceptOrder} from '../dist/domain.js';
import {setCartQuantity,createFoodOrder,transitionFood} from '../dist/food.js';
test('launch focus hides other services and driver without removing their definitions or records',()=>{
 const s=initialState(),before=JSON.stringify(s);assert.deepEqual(enabledServices(),['food','beer']);assert.deepEqual(enabledRoles(),['client','restaurant','courier','admin']);assert.equal(visibleOrders(s).length,0);assert.equal(JSON.stringify(s),before);assert.equal(s.orders.length,2);
 try{featureFlags.deliveryFocus=false;assert.ok(enabledServices().includes('moto'));assert.ok(enabledServices().includes('documents'));assert.ok(enabledRoles().includes('driver'));assert.equal(visibleOrders(s).length,2)}finally{featureFlags.deliveryFocus=true}
 assert.equal(JSON.stringify(s),before);
});
test('hidden active generic delivery does not block food checkout or courier; record stays intact',()=>{
 const s=initialState();const old=createOrder(s,{service:'delivery',from:'Endereço Antigo','to':'Destino Antigo'});s.online.courier=true;acceptOrder(s,old.id,'courier');const snapshot=JSON.stringify(old);setCartQuantity(s,'x-tito',1);const food=createFoodOrder(s,'Rua Exemplo, 120','',true);s.role='restaurant';for(const a of ['restaurantAccept','startPreparing','markReady'])transitionFood(s,food.id,a,food.status);s.role='courier';transitionFood(s,food.id,'courierAccept','ready');assert.equal(food.status,'assigned');assert.equal(JSON.stringify(old),snapshot);assert.equal(s.orders.length,4);assert.deepEqual(visibleOrders(s).map(o=>o.id),[food.id]);
});
test('legacy notification filtering is a non-mutating view',()=>{
 const s=initialState();s.notifications.push({id:'old1',text:'Pedido TJ-1024 concluído',read:false},{id:'old2',text:'João Demo: cadastro aprovado',read:false},{id:'food',text:'TJ-1050: pedido de comida enviado',read:false});const before=JSON.stringify(s.notifications),visible=visibleNotifications(s);assert.ok(!visible.some(n=>n.id==='old1'||n.id==='old2'));assert.ok(visible.some(n=>n.id==='food'));assert.equal(JSON.stringify(s.notifications),before);
});
