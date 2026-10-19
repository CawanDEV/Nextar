import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresStore} from './postgres-store.mjs';
import {Assistant} from './assistant.mjs';
import {processUpdate} from './telegram.mjs';
import {createApp} from './server.mjs';
const url=process.env.POSTGRES_TEST_URL;
const card={holder:'CLIENTE TESTE',number:'4242424242424242',expiry:'12/30',cvc:'123'};
test('PostgreSQL: vendas no estoque original, concorrência, idempotência e rollback', {skip:!url}, async()=>{
 const admin=new pg.Client({connectionString:url});await admin.connect();const schema='test_sales_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
 const clients=[];async function connect(){const client=new pg.Client({connectionString:url});await client.connect();await client.query('SET search_path TO '+schema+',public');clients.push(client);return client;}
 try{
  const first=await connect();
  for(const name of ['001_initial.sql','002_audit_logs.sql','003_suppliers.sql'])await first.query(readFileSync(new URL('../backend/migrations/'+name,import.meta.url),'utf8'));
  const store=new PostgresStore(first);await store.migrate();const second=new PostgresStore(await connect());
  const id=randomUUID();await first.query('INSERT INTO products(id,sku,name,description,unit,quantity,price) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,'CAF-001','Café de teste','Pacote de 250g','un',5,'19.90']);
  const app=createApp({store,config:{baseUrl:'http://localhost:5173'}});
  const update={update_id:19,message:{chat:{id:123,type:'private'},from:{first_name:'Teste'},text:'/comprar CAF-001 2'}};
  await processUpdate(store,app.assistant,update,app.queue);await processUpdate(store,app.assistant,update,app.queue);assert.equal((await store.session('123')).cart[id],2);
  const message=await app.assistant.reply('123','/finalizar','Teste'),token=message.match(/checkout\/([a-f0-9]+)/)[1];
  const result=await Promise.all([store.pay(token,card),second.pay(token,card)]);assert.ok(result.every(o=>o.status==='paid_test'));
  assert.equal((await first.query('SELECT quantity FROM products WHERE id=$1',[id])).rows[0].quantity,3);
  assert.equal((await first.query('SELECT * FROM movements')).rows.length,1);assert.equal((await store.orders())[0].total_cents,3980);
  assert.equal((await store.all("SELECT * FROM audit_logs WHERE action='order.paid_test'")).length,1);
  assert.match(await app.assistant.reply('123','/pedidos'),/aprovado/);
  // Last-unit race across different database clients, not merely a JS queue.
  await first.query('UPDATE products SET quantity=1 WHERE id=$1',[id]);
  const a=await store.createOrder('a','A',{[id]:1}),b=await second.createOrder('b','B',{[id]:1});
  const race=await Promise.allSettled([store.pay(a.token,card),second.pay(b.token,card)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await first.query('SELECT quantity FROM products WHERE id=$1',[id])).rows[0].quantity,0);
  // The first item must be restored if a later item is no longer available.
  const x='00000000-0000-4000-8000-000000000001',y='00000000-0000-4000-8000-000000000002';
  await first.query("INSERT INTO products(id,sku,name,quantity,price) VALUES($1,'X','X',1,1),($2,'Y','Y',1,1)",[x,y]);
  const order=await store.createOrder('rollback','Teste',{[x]:1,[y]:1});await first.query('UPDATE products SET quantity=0 WHERE id=$1',[y]);
  await assert.rejects(store.pay(order.token,card),/Estoque insuficiente/);assert.equal((await first.query('SELECT quantity FROM products WHERE id=$1',[x])).rows[0].quantity,1);
  await store.cancel('rollback');await assert.rejects(store.pay(order.token,card),/cancelado/);
  await assert.rejects(store.pay(token,{...card,cvc:'456'}),/fictícios/);
  // HTTP reads and approval also use PostgreSQL rather than a SQLite fallback.
  const other=await store.createOrder('http','Teste HTTP',{[x]:1});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  try{const base='http://127.0.0.1:'+app.server.address().port;const r=await fetch(base+'/api/v1/checkout/'+other.token+'/pay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(card)});assert.equal(r.status,200);assert.equal((await first.query('SELECT quantity FROM products WHERE id=$1',[x])).rows[0].quantity,0);}finally{await new Promise(r=>app.server.close(r));}
 }finally{for(const client of clients)await client.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
});
