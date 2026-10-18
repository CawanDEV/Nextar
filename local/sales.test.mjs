import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from './store.mjs';
import {Assistant} from './assistant.mjs';
import {createApp} from './server.mjs';
import {processUpdate} from './telegram.mjs';
const card={holder:'CLIENTE TESTE',number:'4242424242424242',expiry:'12/30',cvc:'123'};
const product=(store,sku='CAF-001',quantity=4)=>store.saveProduct({sku,name:'Café especial '+sku,description:'Café em grãos, pacote de 250 g.',unit:'un',quantity,min_quantity:1,price:19.9});
test('venda inteira: catálogo, carrinho, checkout idempotente e baixa auditada',async()=>{
 const s=new Store(),p=product(s),a=new Assistant(s,{baseUrl:'http://localhost:8080'});
 assert.match(await a.reply('1','/catalogo'),/Café em grãos/);
 assert.match(await a.reply('1','quero 2 CAF-001'),/Adicionei 2/);
 const first=await a.reply('1','/finalizar'),second=await a.reply('1','/finalizar');assert.equal(first,second);
 const token=first.match(/checkout\/([a-f0-9]+)/)[1];
 assert.equal(s.products()[0].quantity,4);
 const result=s.pay(token,card);assert.equal(result.status,'paid_test');assert.equal(result.total_cents,3980);
 s.pay(token,card);assert.equal(s.products()[0].quantity,2);assert.equal(s.all('SELECT * FROM movements').length,1);
 assert.equal(s.orders().length,1);assert.equal(s.session('1').cart[p.id],undefined);
 assert.ok(s.all('SELECT * FROM audit_logs').some(l=>l.action==='order.paid_test'));s.db.close();
});
test('dois compradores disputam a última unidade sem estoque negativo',()=>{
 const s=new Store(),p=product(s,'LAST',1),a=s.createOrder('a','A',{[p.id]:1}),b=s.createOrder('b','B',{[p.id]:1});
 s.pay(a.token,card);assert.throws(()=>s.pay(b.token,card),/Estoque insuficiente/);assert.equal(s.products()[0].quantity,0);assert.equal(s.publicOrder(b.token).status,'pending');assert.equal(s.all('SELECT * FROM movements').length,1);s.db.close();
});
test('falha em um item desfaz a baixa dos outros itens',()=>{
 const s=new Store(),a=product(s,'A',1),b=product(s,'B',1),o=s.createOrder('a','A',{[a.id]:1,[b.id]:1});
 s.run('UPDATE products SET quantity=0 WHERE id=?',b.id);assert.throws(()=>s.pay(o.token,card));assert.equal(s.products().find(p=>p.id===a.id).quantity,1);assert.equal(s.all('SELECT * FROM movements').length,0);s.db.close();
});
test('cartão real, pedido expirado e pedido cancelado são recusados',()=>{
 const s=new Store(),p=product(s),o=s.createOrder('a','A',{[p.id]:1});
 assert.throws(()=>s.pay(o.token,{...card,number:'5555555555554444'}),/fictícios/);assert.equal(s.products()[0].quantity,4);
 s.run("UPDATE orders SET expires_at='2000-01-01T00:00:00Z' WHERE id=?",o.id);assert.throws(()=>s.pay(o.token,card),/expirado/);
 const other=s.createOrder('a','A',{[p.id]:1});s.cancel('a');assert.throws(()=>s.pay(other.token,card),/cancelado/);s.db.close();
});
test('carrinhos isolados e cancelamento invalida links antigos',async()=>{
 const s=new Store();product(s);const a=new Assistant(s,{baseUrl:'http://localhost:8080'});
 await a.reply('a','/comprar CAF-001 1');assert.match(await a.reply('b','/carrinho'),/vazio/);
 await a.reply('a','/finalizar');await a.reply('a','/comprar CAF-001 1');assert.equal(s.orders()[0].status,'cancelled');
 assert.match(await a.reply('a','4242424242424242'),/Não envie cartões/);s.db.close();
});
test('reentrega de update Telegram não duplica adição ao carrinho',async()=>{
 const store=new Store(),p=product(store),app=createApp({store});
 const u={update_id:42,message:{chat:{id:123,type:'private'},from:{first_name:'Teste'},text:'/comprar CAF-001 1'}};
 const a=await processUpdate(store,app.assistant,u,app.queue),b=await processUpdate(store,app.assistant,u,app.queue);
 assert.equal(a.reply,b.reply);assert.equal(store.session('123').cart[p.id],1);store.db.close();
});
test('HTTP: checkout limita dados, valida origem e atualiza API do site',async()=>{
 const store=new Store(),p=product(store),o=store.createOrder('a','A',{[p.id]:1}),{server}=createApp({store});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const get=await fetch(base+'/api/v1/checkout/'+o.token),info=await get.json();assert.equal(info.chat_id,undefined);assert.equal(info.token,undefined);
  const denied=await fetch(base+'/api/v1/checkout/'+o.token+'/pay',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify(card)});assert.equal(denied.status,403);
  const pay=await fetch(base+'/api/v1/checkout/'+o.token+'/pay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(card)});assert.equal(pay.status,200);
  const products=await (await fetch(base+'/api/v1/products')).json();assert.equal(products[0].quantity,3);
  const movements=await (await fetch(base+'/api/v1/movements')).json();assert.equal(movements[0].type,'out');
  const unknown=await fetch(base+'/api/v1/checkout/'+'0'.repeat(64));assert.equal(unknown.status,404);
 }finally{await new Promise(r=>server.close(r));store.db.close();}
});
