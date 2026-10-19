import pg from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {BusinessError} from './store.mjs';
const now=()=>new Date().toISOString();
const iso=v=>v instanceof Date?v.toISOString():v;
// Sales tables are namespaced and coexist with Go's products/movements/audit_logs.
export function salesSQL(sql){let n=0;return sql.replace(/\b(sessions|orders|updates|meta)\b/g,'sales_$1').replace(/\?/g,()=>'$'+(++n)).replace('BEGIN IMMEDIATE','BEGIN');}
export class PostgresStore {
 static async open(url){const client=new pg.Client({connectionString:url});await client.connect();const store=new PostgresStore(client);try{await store.migrate();return store;}catch(e){await client.end();throw e;}}
 constructor(client){this.client=client;this.depth=0;this.db={exec:sql=>this.client.query(salesSQL(sql))};}
 async close(){await this.client.end();}
 async migrate(){await this.client.query(`
 CREATE TABLE IF NOT EXISTS sales_sessions(chat_id TEXT PRIMARY KEY,cart TEXT NOT NULL DEFAULT '{}',history TEXT NOT NULL DEFAULT '[]');
 CREATE TABLE IF NOT EXISTS sales_orders(id UUID PRIMARY KEY,chat_id TEXT NOT NULL,customer_name TEXT NOT NULL,items TEXT NOT NULL,total_cents BIGINT NOT NULL CHECK(total_cents>=0),status TEXT NOT NULL CHECK(status IN ('pending','cancelled','paid_test')),token TEXT NOT NULL UNIQUE,created_at TIMESTAMPTZ NOT NULL,expires_at TIMESTAMPTZ NOT NULL,paid_at TIMESTAMPTZ);
 CREATE INDEX IF NOT EXISTS sales_orders_chat_idx ON sales_orders(chat_id,created_at DESC);
 CREATE TABLE IF NOT EXISTS sales_meta(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS sales_updates(id BIGINT PRIMARY KEY,reply TEXT NOT NULL,chat_id TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);
 `);}
 map(row){if(!row)return row;return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?Number(v):['total_cents','id'].includes(k)&&typeof v==='string'&&/^\d+$/.test(v)?Number(v):iso(v)]));}
 async all(sql,...args){return (await this.client.query(salesSQL(sql),args)).rows.map(r=>this.map(r));}
 async get(sql,...args){return (await this.all(sql,...args))[0];}
 async run(sql,...args){const result=await this.client.query(salesSQL(sql),args);return {changes:result.rowCount};}
 async transaction(fn){if(this.depth)return fn();await this.client.query('BEGIN');this.depth=1;try{const result=await fn();await this.client.query('COMMIT');return result;}catch(e){await this.client.query('ROLLBACK');throw e;}finally{this.depth=0;}}
 async audit(action,type,id,summary){await this.client.query('INSERT INTO audit_logs(id,action,entity_type,entity_id,summary) VALUES($1,$2,$3,$4,$5)',[randomUUID(),action,type,id,summary]);}
 async products(){return (await this.client.query('SELECT id,sku,name,description,unit,quantity,price FROM products ORDER BY name')).rows.map(p=>({...p,price:Number(p.price),price_cents:Math.round(Number(p.price)*100)}));}
 async session(chat){await this.run('INSERT INTO sessions(chat_id) VALUES(?) ON CONFLICT(chat_id) DO NOTHING',String(chat));const s=await this.get('SELECT * FROM sessions WHERE chat_id=?',String(chat));return {cart:JSON.parse(s.cart),history:JSON.parse(s.history)};}
 async saveSession(chat,s){await this.run('UPDATE sessions SET cart=?,history=? WHERE chat_id=?',JSON.stringify(s.cart),JSON.stringify(s.history.slice(-12)),String(chat));}
 async createOrder(chat,name,cart){return this.transaction(async()=>{
  const items=[];
  for(const [id,quantity] of Object.entries(cart).sort(([a],[b])=>a.localeCompare(b))){
   if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1_000_000)throw new BusinessError('Quantidade inválida.');
   const p=await this.get('SELECT id,sku,name,price,quantity FROM products WHERE id=?',id);if(!p||p.quantity<quantity)throw new BusinessError('Estoque insuficiente. Revise o carrinho.',409);
   items.push({product_id:id,name:p.name,sku:p.sku,quantity,unit_price_cents:Math.round(Number(p.price)*100)});
  }
  if(!items.length)throw new BusinessError('Seu carrinho está vazio.');
  const signature=JSON.stringify(items),existing=await this.get("SELECT * FROM orders WHERE chat_id=? AND status='pending' AND items=? AND expires_at>?",String(chat),signature,now());if(existing)return existing;
  await this.run("UPDATE orders SET status='cancelled' WHERE chat_id=? AND status='pending'",String(chat));
  const id=randomUUID(),token=randomBytes(32).toString('hex'),total=items.reduce((sum,i)=>sum+i.quantity*i.unit_price_cents,0);
  if(!Number.isSafeInteger(total))throw new BusinessError('Valor do pedido excede o limite.');
  await this.run('INSERT INTO orders(id,chat_id,customer_name,items,total_cents,status,token,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',id,String(chat),name.slice(0,100),signature,total,'pending',token,now(),new Date(Date.now()+30*60_000).toISOString());
  await this.audit('order.created','order',id,'Pedido de teste aguardando pagamento');return this.get('SELECT * FROM orders WHERE id=?',id);
 });}
 async publicOrder(token){const o=await this.get('SELECT * FROM orders WHERE token=?',token);if(!o)throw new BusinessError('Pedido não encontrado.',404);return {...o,items:JSON.parse(o.items),expired:o.expires_at<now()};}
 async pay(token,card){
  if(card.number!=='4242424242424242'||card.expiry!=='12/30'||card.cvc!=='123'||card.holder!=='CLIENTE TESTE')throw new BusinessError('Use apenas os dados fictícios indicados na tela.');
  return this.transaction(async()=>{
   // Serialize duplicate approvals across different connections/processes.
   const row=await this.get('SELECT * FROM orders WHERE token=? FOR UPDATE',token);if(!row)throw new BusinessError('Pedido não encontrado.',404);
   const o={...row,items:JSON.parse(row.items)};if(o.status==='paid_test')return o;
   if(o.status!=='pending'||o.expires_at<now())throw new BusinessError('Pedido cancelado ou expirado. Gere outro no atendimento.',409);
   for(const item of o.items){
    // Lock product rows in the deterministic order used when creating the cart.
    const result=await this.run('UPDATE products SET quantity=quantity-?,updated_at=now() WHERE id=? AND quantity>=?',item.quantity,item.product_id,item.quantity);
    if(!result.changes)throw new BusinessError('Estoque insuficiente. Nenhuma cobrança realizada; refaça o pedido.',409);
    const id=randomUUID();await this.run('INSERT INTO movements(id,product_id,type,quantity,note) VALUES(?,?,?,?,?)',id,item.product_id,'out',item.quantity,'Venda TESTE '+o.id);await this.audit('movement.created','movement',id,'Venda de teste: '+item.name);
   }
   await this.run("UPDATE orders SET status='paid_test',paid_at=now() WHERE id=?",o.id);await this.run("UPDATE sessions SET cart='{}' WHERE chat_id=?",o.chat_id);
   await this.audit('order.paid_test','order',o.id,'Pagamento simulado aprovado; estoque atualizado');return this.publicOrder(token);
  });
 }
 async cancel(chat){await this.transaction(async()=>{await this.run("UPDATE orders SET status='cancelled' WHERE chat_id=? AND status='pending'",String(chat));const s=await this.session(chat);s.cart={};await this.saveSession(chat,s);});}
 async orders(){return (await this.all('SELECT id,customer_name,total_cents,status,created_at,paid_at,items FROM orders ORDER BY created_at DESC LIMIT 200')).map(o=>({...o,items:JSON.parse(o.items)}));}
}
