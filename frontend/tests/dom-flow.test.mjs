import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const JSDOM=process.env.TITOJA_JSDOM_PATH?(await import(process.env.TITOJA_JSDOM_PATH)).JSDOM:null;
const source=['features','food','tracking','domain','app'].map(f=>readFileSync(new URL(`../dist/${f}.js`,import.meta.url),'utf8').replace(/^import .*;\s*$/gm,'').replace(/^export /gm,'')).join('\n');
const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g,'');
const key='titoja.demo.v1';
const errors=[];
function load(saved=null,hash='#/client/home'){
 const dom=new JSDOM(html,{url:'https://titoja.test/'+hash,runScripts:'outside-only'}),w=dom.window;
 w.scrollTo=()=>{};w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 w.addEventListener('error',e=>errors.push(e.error));if(saved)w.localStorage.setItem(key,saved);w.eval(source);return dom;
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const get=s=>JSON.parse(s.window.localStorage.getItem(key));
async function click(s,selector){const e=s.window.document.querySelector(selector);assert.ok(e,'Missing '+selector);assert.ok(!e.disabled,'Disabled '+selector);e.click();await tick();return e;}
async function submit(s,selector){const form=s.window.document.querySelector(selector);assert.ok(form,'Missing form '+selector);form.dispatchEvent(new s.window.Event('submit',{bubbles:true,cancelable:true}));await tick();}
const action=(a,extra='')=>`[data-action="${a}"]${extra}`;
const role=(s,r)=>click(s,action('role',`[data-role="${r}"]`));
const step=(s,a)=>click(s,action('food-transition',`[data-food-action="${a}"]`));
test('DOM: client cart checkout, restaurant, ready-only courier, reload, history and admin',{skip:!JSDOM},async()=>{
 let dom=load();try{
  await click(dom,action('food-register'));const form=dom.window.document.querySelector('#food-register-form');form.elements.name.value='Cliente Fluxo Demo';await submit(dom,'#food-register-form');assert.equal(get(dom).demoProfiles.client.registered,true);
  await click(dom,action('food-open'));assert.equal(dom.window.document.querySelectorAll('.restaurant-card').length,1);
  await click(dom,action('food-menu'));assert.equal(dom.window.document.querySelectorAll('.menu-product').length,7);
  await click(dom,action('food-add','[data-id="x-tito"]'));await click(dom,action('food-add','[data-id="x-tito"]'));await click(dom,action('food-add','[data-id="refri"]'));await click(dom,action('food-add','[data-id="misto"]'));
  await click(dom,action('food-cart'));await click(dom,action('food-remove','[data-id="misto"]'));assert.equal(get(dom).foodCart.length,2);
  const cartSaved=dom.window.localStorage.getItem(key);dom.window.close();dom=load(cartSaved,'#/client/cart');assert.equal(dom.window.document.querySelectorAll('.cart-item').length,2);
  await click(dom,action('food-checkout'));dom.window.document.querySelector('[name="paymentApproved"]').checked=true;dom.window.document.querySelector('[name="note"]').value='Sem cebola';await submit(dom,'#food-checkout-form');
  let order=get(dom).orders[0];assert.equal(order.service,'food');assert.equal(order.status,'pendingAcceptance');assert.equal(order.price,58);assert.equal(order.food.customerName,'Cliente Fluxo Demo');assert.equal(order.note,'Sem cebola');assert.ok(dom.window.document.body.textContent.includes('Seu pedido chegou à cozinha'));const id=order.id;
  await role(dom,'courier');await click(dom,action('online'));assert.equal(dom.window.document.querySelectorAll('.food-offer').length,0);
  await role(dom,'restaurant');assert.equal(dom.window.document.querySelectorAll('.restaurant-order').length,1);assert.ok(dom.window.document.body.textContent.includes(id));assert.ok(dom.window.document.body.textContent.includes('2×'));
  await step(dom,'restaurantAccept');assert.equal(get(dom).orders[0].status,'restaurantAccepted');await step(dom,'startPreparing');assert.equal(get(dom).orders[0].status,'preparing');
  await role(dom,'courier');assert.equal(dom.window.document.querySelectorAll('.food-offer').length,0);
  await role(dom,'restaurant');await step(dom,'markReady');assert.equal(get(dom).orders[0].status,'ready');await role(dom,'courier');assert.equal(dom.window.document.querySelectorAll('.food-offer').length,1);assert.ok(dom.window.document.querySelector('.food-offer').textContent.includes('8,00'));
  await step(dom,'courierAccept');assert.equal(get(dom).orders[0].status,'assigned');const saved=dom.window.localStorage.getItem(key);dom.window.close();dom=load(saved,`#/courier/order/${id}`);assert.ok(dom.window.document.body.textContent.includes('Entrega aceita. Bora buscar?'));assert.ok(dom.window.document.querySelector(action('food-transition','[data-food-action="goPickup"]')));
  for(const [a,status] of [['goPickup','pickingUp'],['confirmPickup','foodCollected'],['startDelivery','outForDelivery'],['deliver','completed']]){await step(dom,a);assert.equal(get(dom).orders[0].status,status)}
  const final=get(dom).orders[0];assert.equal(final.id,id);assert.equal(final.food.history.length,9);assert.equal(final.price,58);assert.deepEqual(final.food.items,order.food.items);assert.ok(final.finished);
  await role(dom,'client');dom.window.location.hash='#/client/orders';await tick();await click(dom,action('order',`[data-id="${id}"]`));assert.ok(dom.window.document.body.textContent.includes('Entrega concluída.'));assert.ok(dom.window.document.body.textContent.includes('Pagamento fictício aprovado'));
  await role(dom,'restaurant');assert.ok(dom.window.document.body.textContent.includes('Histórico da cozinha'));await role(dom,'admin');assert.ok(dom.window.document.body.textContent.includes(id));await click(dom,action('admin','[data-value="finance"]'));assert.ok(dom.window.document.body.textContent.includes('sem comissão comercial definida'));
  assert.equal(errors.length,0,errors.map(e=>e?.stack).join('\n'));
 }finally{dom.window.close()}
});
test('DOM: empty cart, failed checkout, cancel keep, cancellation and role registration',{skip:!JSDOM},async()=>{
 let dom=load();try{
  dom.window.location.hash='#/client/cart';await tick();assert.ok(dom.window.document.body.textContent.includes('Sua sacola está vazia'));
  await click(dom,action('food-menu'));await click(dom,action('food-add','[data-id="x-salada"]'));await click(dom,action('food-cart'));await click(dom,action('food-minus','[data-id="x-salada"]'));assert.equal(get(dom).foodCart.length,0);
  await click(dom,action('food-menu'));await click(dom,action('food-add','[data-id="batata"]'));await click(dom,action('food-cart'));await click(dom,action('food-checkout'));await submit(dom,'#food-checkout-form');assert.ok(dom.window.document.querySelector('#form-error').textContent.includes('Confirme o pagamento'));assert.equal(get(dom).orders.filter(o=>o.food).length,0);
  dom.window.document.querySelector('[name="paymentApproved"]').checked=true;await submit(dom,'#food-checkout-form');await click(dom,action('food-cancel'));await click(dom,'#modal '+action('close'));assert.equal(get(dom).orders[0].status,'pendingAcceptance');await click(dom,action('food-cancel'));await step(dom,'cancel');assert.equal(get(dom).orders[0].status,'cancelled');assert.equal(get(dom).orders[0].food.paymentStatus,'cancelled');
  for(const r of ['restaurant','courier']){await role(dom,r);await click(dom,action('food-register'));dom.window.document.querySelector('#food-register-form').elements.name.value=r+' Novo Demo';await submit(dom,'#food-register-form');assert.equal(get(dom).demoProfiles[r].registered,true)}
  assert.equal(errors.length,0,errors.map(e=>e?.stack).join('\n'));
 }finally{dom.window.close()}
});

test('DOM: every shared food state renders appropriate animated scene and actions for all three roles',{skip:!JSDOM},async()=>{
 let seed=load();const baseline=get(seed);seed.window.close();const now=new Date().toISOString();
 const states={pendingAcceptance:'waiting',restaurantAccepted:'preparing',preparing:'preparing',ready:'ready',assigned:'pickup',pickingUp:'pickup',foodCollected:'pickup',outForDelivery:'moving',completed:'delivered',cancelled:'cancelled'};
 for(const roleName of ['client','restaurant','courier'])for(const [status,scene] of Object.entries(states)){
  const s=JSON.parse(JSON.stringify(baseline));s.role=roleName;s.online.courier=true;const assigned=['assigned','pickingUp','foodCollected','outForDelivery','completed'].includes(status);
  const order={id:'TJ-1030',service:'food',kind:'delivery',from:'Lanchonete Demo',to:'Rua Exemplo, 120',created:now,status,price:30,distance:2,minutes:30,professional:assigned?'courier':undefined,food:{restaurantId:'tito-lanches-demo',restaurantName:'Lanchonete do Tito',customerName:'Cliente Demo',restaurantOperator:'Bia Demo',courierName:assigned?'Lia Demo':undefined,items:[{productId:'x-tito',name:'X-Tito da casa',unitPrice:22,quantity:1,lineTotal:22}],subtotal:22,deliveryFee:8,total:30,paymentStatus:status==='cancelled'?'cancelled':'approved',paymentApprovedAt:now,history:[{status,at:now,by:roleName}]}};s.orders.unshift(order);
  const dom=load(JSON.stringify(s),`#/${roleName}/order/TJ-1030`);try{
   assert.equal(dom.window.document.querySelector('.tracking-panel')?.dataset.trackingStatus,status);assert.ok(dom.window.document.querySelector(`.scene-${scene}`));assert.equal(dom.window.document.querySelectorAll('.tracking-progress li').length,status==='cancelled'?0:6);assert.ok(dom.window.document.body.textContent.includes('sem GPS'));
   assert.equal(get(dom).orders[0].status,status);assert.equal(get(dom).orders[0].food.history.length,1);
   if(assigned)assert.ok(dom.window.document.querySelector('.tracking-courier').textContent.includes('Lia Demo'));
   if(['pickup','moving'].includes(scene))assert.ok(dom.window.document.querySelector('.tracking-illustration img[src="./assets/delivery-scooter.png"]'));
   if(roleName==='client')assert.equal(dom.window.document.querySelectorAll('[data-food-action]').length,0);
   if(roleName==='courier'&&['pendingAcceptance','restaurantAccepted','preparing'].includes(status))assert.equal(dom.window.document.querySelectorAll('[data-food-action="courierAccept"]').length,0);
  }finally{dom.window.close()}
 }
 assert.equal(errors.length,0,errors.map(e=>e?.stack).join('\n'));
});

test('DOM: focused home has exactly food and beer, no hidden roles, and beer stays coming soon',{skip:!JSDOM},async()=>{
 const dom=load();try{
  const d=dom.window.document;assert.deepEqual([...d.querySelectorAll('.delivery-choice')].map(b=>b.dataset.service),['food','beer']);assert.equal(d.querySelectorAll('.role-picker button').length,4);assert.equal(d.querySelector('[data-role="driver"]'),null);assert.equal(d.querySelector('[data-action="request"]'),null);assert.ok(!/Mototáxi|Farmácia|Documentos|Corridas|Motorista/.test(d.body.textContent));assert.equal(d.querySelectorAll('.order-card').length,0);assert.equal(get(dom).orders.length,2);
  await click(dom,'[data-service="beer"]');assert.ok(d.querySelector('#modal').textContent.includes('Em breve'));assert.equal(d.querySelector('#modal [data-action="request"]'),null);assert.equal(get(dom).orders.length,2);await click(dom,'#modal [data-action="close"]');
  for(const r of ['client','restaurant','courier','admin']){await role(dom,r);for(const page of ['home','orders','wallet','profile']){dom.window.location.hash=`#/${r}/${page}`;await tick();assert.ok(!/Mototáxi|Farmácia|Corridas|Motorista|TJ-1024|TJ-1023|15%/.test(d.body.textContent),r+' '+page);assert.equal(d.querySelector('[data-action="apply"]'),null);assert.equal(d.querySelector('[data-role="driver"]'),null)}}
  assert.equal(get(dom).orders.length,2);assert.equal(errors.length,0,errors.map(e=>e?.stack).join('\n'));
 }finally{dom.window.close()}
});

test('DOM: stale driver role, hidden order/apply deep links and legacy activity are isolated without data loss',{skip:!JSDOM},async()=>{
 let dom=load();let seed=get(dom);dom.window.close();seed.role='driver';seed.online.driver=true;seed.orders.push({id:'TJ-1099',service:'delivery',kind:'delivery',from:'Retirada antiga',to:'Destino antigo',status:'accepted',professional:'courier',price:15,distance:3,minutes:10,created:new Date().toISOString(),rejectedBy:['driver']});const legacySnapshot=JSON.stringify(seed.orders),applicationsSnapshot=JSON.stringify(seed.applications);
 dom=load(JSON.stringify(seed),'#/driver/home');try{
  await tick();assert.equal(get(dom).role,'client');assert.equal(dom.window.location.hash,'#/client/home');assert.ok(dom.window.document.querySelector('.delivery-choices'));assert.equal(JSON.stringify(get(dom).orders),legacySnapshot);assert.equal(JSON.stringify(get(dom).applications),applicationsSnapshot);assert.equal(get(dom).online.driver,true);
  dom.window.location.hash='#/client/order/TJ-1024';await tick();assert.ok(dom.window.document.body.textContent.includes('Pedido não encontrado'));assert.ok(!dom.window.document.body.textContent.includes('Mototáxi'));
  dom.window.location.hash='#/client/apply';await tick();await tick();assert.equal(dom.window.location.hash,'#/client/profile');assert.equal(dom.window.document.querySelector('#application-form'),null);
  await role(dom,'courier');assert.equal(dom.window.document.querySelector('[data-id="TJ-1099"]'),null);await click(dom,'[data-action="restore-queue"]');assert.equal(JSON.stringify(get(dom).orders),legacySnapshot);
  await role(dom,'client');await click(dom,action('food-open'));await click(dom,action('food-menu'));await click(dom,action('food-add','[data-id="x-tito"]'));await click(dom,action('food-cart'));await click(dom,action('food-checkout'));assert.ok(dom.window.document.querySelector('#food-checkout-form'));dom.window.document.querySelector('[name="paymentApproved"]').checked=true;await submit(dom,'#food-checkout-form');assert.equal(get(dom).orders[0].service,'food');assert.equal(JSON.stringify(get(dom).orders.slice(1)),legacySnapshot);
  assert.equal(errors.length,0,errors.map(e=>e?.stack).join('\n'));
 }finally{dom.window.close()}
});
