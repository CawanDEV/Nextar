import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';

export class BusinessError extends Error { constructor(message, status=400) { super(message); this.status=status; } }
export const money = cents => (cents/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
export const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const now = () => new Date().toISOString();
const integer = (n,min=0) => Number.isSafeInteger(n) && n>=min && n<=1_000_000;
export class Store {
 constructor(path=':memory:') {
  this.db=new DatabaseSync(path);
  this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS suppliers(id TEXT PRIMARY KEY,name TEXT NOT NULL,contact_name TEXT,email TEXT,phone TEXT,notes TEXT,created_at TEXT);
   CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,sku TEXT NOT NULL UNIQUE,name TEXT NOT NULL,description TEXT,unit TEXT,quantity INTEGER CHECK(quantity>=0),min_quantity INTEGER,price_cents INTEGER CHECK(price_cents>=0),supplier_id TEXT REFERENCES suppliers(id),created_at TEXT);
   CREATE TABLE IF NOT EXISTS movements(id TEXT PRIMARY KEY,product_id TEXT REFERENCES products(id),type TEXT,quantity INTEGER,note TEXT,created_at TEXT);
   CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY,action TEXT,entity_type TEXT,entity_id TEXT,summary TEXT,created_at TEXT);
   CREATE TABLE IF NOT EXISTS sessions(chat_id TEXT PRIMARY KEY,cart TEXT NOT NULL DEFAULT '{}',history TEXT NOT NULL DEFAULT '[]');
   CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,customer_name TEXT NOT NULL,items TEXT NOT NULL,total_cents INTEGER NOT NULL,status TEXT NOT NULL,token TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,paid_at TEXT);
   CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
   CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY,reply TEXT NOT NULL,chat_id TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);
  `);
 }
 all(sql,...args){return this.db.prepare(sql).all(...args);}
 get(sql,...args){return this.db.prepare(sql).get(...args);}
 run(sql,...args){return this.db.prepare(sql).run(...args);}
 transaction(fn){if(this.depth)return fn();this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 audit(action,type,id,summary){this.run('INSERT INTO audit_logs VALUES(?,?,?,?,?,?)',randomUUID(),action,type,id,summary,now());}
 products(){return this.all(`SELECT p.*,COALESCE(s.name,'') supplier_name FROM products p LEFT JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.name`).map(p=>({...p,price:p.price_cents/100,supplier_id:p.supplier_id||''}));}
 saveProduct(p,id){
  if(typeof p.name!=='string'||!p.name.trim()||typeof p.sku!=='string'||!p.sku.trim()||!p.unit?.trim()||!integer(p.quantity)||!integer(p.min_quantity)||!Number.isFinite(p.price)||p.price<0||p.price>10_000_000)throw new BusinessError('Confira nome, SKU, unidade, preço e quantidades.');
  return this.transaction(()=>{
   if(id&&!this.get('SELECT id FROM products WHERE id=?',id))throw new BusinessError('Produto não encontrado.',404);
   const key=id||randomUUID(), cents=Math.round(p.price*100);
   if(id)this.run('UPDATE products SET sku=?,name=?,description=?,unit=?,min_quantity=?,price_cents=?,supplier_id=? WHERE id=?',p.sku.trim(),p.name.trim(),p.description||'',p.unit,p.min_quantity,cents,p.supplier_id||null,key);
   else this.run('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?,?)',key,p.sku.trim(),p.name.trim(),p.description||'',p.unit,p.quantity,p.min_quantity,cents,p.supplier_id||null,now());
   this.audit(id?'product.updated':'product.created','product',key,'Produto '+(id?'atualizado: ':'cadastrado: ')+p.name);
   return this.products().find(p=>p.id===key);
  });
 }
 movement(p){return this.transaction(()=>{
  if(!['in','out'].includes(p.type)||!integer(p.quantity,1))throw new BusinessError('Quantidade ou tipo inválido.');
  const product=this.get('SELECT * FROM products WHERE id=?',p.product_id);if(!product)throw new BusinessError('Produto não encontrado.',404);
  if(p.type==='out'&&product.quantity<p.quantity)throw new BusinessError('Estoque insuficiente.',409);
  this.run('UPDATE products SET quantity=quantity+? WHERE id=?',(p.type==='in'?1:-1)*p.quantity,product.id);
  const id=randomUUID();this.run('INSERT INTO movements VALUES(?,?,?,?,?,?)',id,product.id,p.type,p.quantity,p.note||'',now());
  this.audit('movement.created','movement',id,'Movimentação: '+product.name);return {id};
 });}
 session(chat){this.run('INSERT OR IGNORE INTO sessions(chat_id) VALUES(?)',String(chat));const s=this.get('SELECT * FROM sessions WHERE chat_id=?',String(chat));return {cart:JSON.parse(s.cart),history:JSON.parse(s.history)};}
 saveSession(chat,s){this.run('UPDATE sessions SET cart=?,history=? WHERE chat_id=?',JSON.stringify(s.cart),JSON.stringify(s.history.slice(-12)),String(chat));}
 createOrder(chat,name,cart){return this.transaction(()=>{
  const items=Object.entries(cart).sort(([a],[b])=>a.localeCompare(b)).map(([id,quantity])=>{
   if(!integer(quantity,1))throw new BusinessError('Quantidade inválida.');
   const p=this.get('SELECT * FROM products WHERE id=?',id);if(!p||p.quantity<quantity)throw new BusinessError('Estoque insuficiente. Revise o carrinho.',409);
   return {product_id:id,name:p.name,sku:p.sku,quantity,unit_price_cents:p.price_cents};
  });
  if(!items.length)throw new BusinessError('Seu carrinho está vazio.');
  const signature=JSON.stringify(items),existing=this.get("SELECT * FROM orders WHERE chat_id=? AND status='pending' AND items=? AND expires_at>?",String(chat),signature,now());
  if(existing)return existing;
  this.run("UPDATE orders SET status='cancelled' WHERE chat_id=? AND status='pending'",String(chat));
  const id=randomUUID(),token=randomBytes(32).toString('hex'),total=items.reduce((s,i)=>s+i.quantity*i.unit_price_cents,0),created=now(),expires=new Date(Date.now()+30*60_000).toISOString();
  this.run('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,NULL)',id,String(chat),name.slice(0,100),signature,total,'pending',token,created,expires);
  this.audit('order.created','order',id,'Pedido de teste aguardando pagamento');return this.get('SELECT * FROM orders WHERE id=?',id);
 });}
 publicOrder(token){const o=this.get('SELECT * FROM orders WHERE token=?',token);if(!o)throw new BusinessError('Pedido não encontrado.',404);return {...o,items:JSON.parse(o.items),expired:o.expires_at<now()};}
 pay(token,card){
  // Apenas uma credencial sintética aceita. Nunca gravar nem registrar o corpo do checkout.
  if(card.number!=='4242424242424242'||card.expiry!=='12/30'||card.cvc!=='123'||card.holder!=='CLIENTE TESTE')throw new BusinessError('Use apenas os dados fictícios indicados na tela.');
  return this.transaction(()=>{
   const o=this.publicOrder(token);if(o.status==='paid_test')return o;
   if(o.status!=='pending'||o.expired)throw new BusinessError('Pedido cancelado ou expirado. Gere outro no atendimento.',409);
   for(const item of o.items){const result=this.run('UPDATE products SET quantity=quantity-? WHERE id=? AND quantity>=?',item.quantity,item.product_id,item.quantity);if(!result.changes)throw new BusinessError('Estoque insuficiente. Nenhuma cobrança realizada; refaça o pedido.',409);
    const id=randomUUID();this.run('INSERT INTO movements VALUES(?,?,?,?,?,?)',id,item.product_id,'out',item.quantity,'Venda TESTE '+o.id,now());this.audit('movement.created','movement',id,'Venda de teste: '+item.name);
   }
   this.run("UPDATE orders SET status='paid_test',paid_at=? WHERE id=?",now(),o.id);
   this.run("UPDATE sessions SET cart='{}' WHERE chat_id=?",o.chat_id);
   this.audit('order.paid_test','order',o.id,'Pagamento simulado aprovado; estoque atualizado');return this.publicOrder(token);
  });
 }
 cancel(chat){this.run("UPDATE orders SET status='cancelled' WHERE chat_id=? AND status='pending'",String(chat));const s=this.session(chat);s.cart={};this.saveSession(chat,s);}
 orders(){return this.all('SELECT id,customer_name,total_cents,status,created_at,paid_at,items FROM orders ORDER BY created_at DESC LIMIT 200').map(o=>({...o,items:JSON.parse(o.items)}));}
}
