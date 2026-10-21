import test from 'node:test';import assert from 'node:assert/strict';
import {trackingView,trackingStages} from '../dist/tracking.js';
import {initialState} from '../dist/domain.js';
import {setCartQuantity,createFoodOrder} from '../dist/food.js';
import {readFileSync} from 'node:fs';
test('tracking has six truthful groups and distinct local states for all three roles',()=>{
 const expected={pendingAcceptance:[0,'waiting'],restaurantAccepted:[1,'preparing'],preparing:[1,'preparing'],ready:[2,'ready'],assigned:[3,'pickup'],pickingUp:[3,'pickup'],foodCollected:[3,'pickup'],outForDelivery:[4,'moving'],completed:[5,'delivered'],cancelled:[-1,'cancelled']};
 assert.equal(trackingStages.length,6);
 for(const role of ['client','restaurant','courier'])for(const [status,[stage,scene]] of Object.entries(expected)){
   const v=trackingView(status,role);assert.equal(v.stage,stage);assert.equal(v.scene,scene);assert.ok(v.title&&v.description&&v.next);assert.ok(!/\d+\s*min|GPS ao vivo|chegará/.test(v.description));
 }
 assert.match(trackingView('restaurantAccepted','client').description,/vai iniciar/);
 assert.match(trackingView('preparing','client').description,/está em preparo/);
 assert.match(trackingView('ready','client').description,/aguarda um entregador/);
 assert.match(trackingView('foodCollected','courier').next,/Sair para entrega/);
 assert.notEqual(trackingView('preparing','restaurant').title,trackingView('preparing','client').title);
});
test('presentation does not mutate orders, and reduced motion is explicitly supported',()=>{
 const s=initialState();setCartQuantity(s,'x-tito',1);const o=createFoodOrder(s,'Rua Exemplo, 123','',true),before=JSON.stringify(s);
 for(let i=0;i<100;i++)trackingView(o.status,'client');assert.equal(JSON.stringify(s),before);assert.equal(o.status,'pendingAcceptance');assert.equal(o.food.history.length,1);
 const css=readFileSync(new URL('../dist/style.css',import.meta.url),'utf8');assert.ok(css.includes('@media(prefers-reduced-motion:reduce)'));assert.match(css,/\.tracking-panel \*,\.food-work-card \*\{animation:none!important/);
});
