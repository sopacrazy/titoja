import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,createOrder,acceptOrder,advanceOrder,cancelOrder,updateDeliveryLabels} from '../dist/domain.js';
import {restaurant,menu,cartItems,cartSubtotal,setCartQuantity,createFoodOrder,transitionFood,foodCourierQueue,registerDemoProfile} from '../dist/food.js';
const checkout=s=>{setCartQuantity(s,'x-tito',2);setCartQuantity(s,'refri',1);return createFoodOrder(s,'Rua Exemplo, 120 · Centro','Sem cebola',true)};
const act=(s,o,role,action)=>{s.role=role;return transitionFood(s,o.id,action,o.status)};
test('food complete client restaurant courier client cycle, shared items and totals',()=>{
 let s=initialState(),o=checkout(s);assert.equal(o.status,'pendingAcceptance');assert.equal(o.food.subtotal,50);assert.equal(o.price,58);assert.equal(o.food.deliveryFee,8);assert.equal(o.food.items.length,2);assert.equal(s.foodCart.length,0);assert.equal(foodCourierQueue(s).length,0);
 for(const action of ['restaurantAccept','startPreparing']){act(s,o,'restaurant',action);assert.equal(foodCourierQueue(s).length,0)}
 act(s,o,'restaurant','markReady');assert.equal(foodCourierQueue(s).length,1);s.role='courier';assert.throws(()=>transitionFood(s,o.id,'courierAccept','ready'),/disponível/);s.online.courier=true;
 act(s,o,'courier','courierAccept');assert.equal(foodCourierQueue(s).length,0);const snapshot=JSON.stringify(o.food.items);
 s=JSON.parse(JSON.stringify(s));o=s.orders.find(x=>x.id===o.id);for(const action of ['goPickup','confirmPickup','startDelivery','deliver'])act(s,o,'courier',action);
 assert.equal(o.status,'completed');assert.equal(o.food.history.length,9);assert.ok(o.finished);assert.ok(o.food.history.every(x=>!Number.isNaN(Date.parse(x.at))));assert.equal(JSON.stringify(o.food.items),snapshot);assert.equal(o.price,58);assert.equal(s.balance,120);s.role='client';assert.equal(s.orders[0].id,o.id);assert.equal(s.orders[0].status,'completed');
});
test('food cannot dispatch early, skip steps, use wrong profile or legacy transitions',()=>{
 const s=initialState(),o=checkout(s);s.online.courier=true;s.role='courier';assert.throws(()=>transitionFood(s,o.id,'courierAccept',o.status));assert.throws(()=>transitionFood(s,o.id,'markReady',o.status));assert.throws(()=>acceptOrder(s,o.id,'courier'));assert.throws(()=>advanceOrder(s,o.id,'courier'));assert.throws(()=>cancelOrder(s,o.id));assert.equal(o.status,'pendingAcceptance');
 act(s,o,'restaurant','restaurantAccept');assert.throws(()=>transitionFood(s,o.id,'markReady',o.status));assert.throws(()=>transitionFood(s,o.id,'cancel',o.status));assert.equal(o.food.history.length,2);
});
test('explicit actions and expected status prevent repeated or double-click progression',()=>{
 const s=initialState(),o=checkout(s);s.role='restaurant';transitionFood(s,o.id,'restaurantAccept','pendingAcceptance');assert.throws(()=>transitionFood(s,o.id,'restaurantAccept','pendingAcceptance'));assert.equal(o.status,'restaurantAccepted');assert.equal(o.food.history.length,2);act(s,o,'restaurant','startPreparing');act(s,o,'restaurant','markReady');s.online.courier=true;
 for(const a of ['courierAccept','goPickup','confirmPickup','startDelivery','deliver']){const before=o.status;act(s,o,'courier',a);assert.throws(()=>transitionFood(s,o.id,a,before));}assert.equal(o.food.history.length,9);assert.throws(()=>transitionFood(s,o.id,'deliver','completed'));
});
test('cart, checkout approval, empty order, quantity, role and duplicate guards',()=>{
 const s=initialState();assert.throws(()=>createFoodOrder(s,'Rua Exemplo','',true));setCartQuantity(s,'x-tito',2);assert.equal(cartSubtotal(s),44);setCartQuantity(s,'x-tito',1);assert.equal(cartSubtotal(s),22);setCartQuantity(s,'x-tito',0);assert.equal(s.foodCart.length,0);assert.throws(()=>setCartQuantity(s,'nope',1));assert.throws(()=>setCartQuantity(s,'x-tito',21));assert.throws(()=>setCartQuantity(s,'x-tito',1.2));setCartQuantity(s,'x-tito',1);assert.throws(()=>createFoodOrder(s,'Rua Exemplo','',false));assert.throws(()=>createFoodOrder(s,'a','',true));const o=createFoodOrder(s,'Rua Exemplo','',true);assert.throws(()=>createFoodOrder(s,'Rua Exemplo','',true));setCartQuantity(s,'refri',1);assert.throws(()=>createFoodOrder(s,'Rua Exemplo','',true));assert.equal(s.orders.filter(o=>o.food).length,1);assert.equal(o.food.items[0].quantity,1);s.role='restaurant';assert.throws(()=>setCartQuantity(s,'refri',2));assert.throws(()=>createFoodOrder(s,'Rua Exemplo','',true));
});
test('cancellation and restaurant refusal before acceptance only; no money changes',()=>{
 for(const role of ['client','restaurant']){const s=initialState(),o=checkout(s);act(s,o,role,role==='client'?'cancel':'restaurantReject');assert.equal(o.status,'cancelled');assert.equal(o.food.paymentStatus,'cancelled');assert.equal(foodCourierQueue(s).length,0);assert.equal(s.balance,120);s.role='client';assert.ok(checkout(s));}
});
test('demo registration, existing-data migration and cart persistence',()=>{
 const s=initialState();delete s.foodCart;delete s.demoProfiles;s.name='Nome preservado';updateDeliveryLabels(s);assert.equal(s.name,'Nome preservado');assert.equal(s.orders.length,2);for(const role of ['client','restaurant','courier']){registerDemoProfile(s,role,role+' Teste');assert.equal(s.demoProfiles[role].registered,true)}s.role='client';setCartQuantity(s,'x-bacon',3);const copy=updateDeliveryLabels(JSON.parse(JSON.stringify(s)));assert.deepEqual(copy,s);assert.equal(cartItems(copy)[0].lineTotal,81);assert.equal(copy.demoProfiles.courier.name,'courier Teste');
});
test('one restaurant, no unintended commission, active courier concurrency',()=>{
 assert.equal(restaurant.deliveryFee,8);assert.equal(menu.length,7);const s=initialState(),o=checkout(s);act(s,o,'restaurant','restaurantAccept');act(s,o,'restaurant','startPreparing');act(s,o,'restaurant','markReady');s.orders.push({...o,id:'TJ-9999',status:'assigned',professional:'courier',food:structuredClone(o.food)});s.online.courier=true;s.role='courier';assert.throws(()=>transitionFood(s,o.id,'courierAccept','ready'),/Finalize/);assert.equal(o.status,'ready');assert.equal(o.food.deliveryFee,8);assert.equal(o.price,58);
});
