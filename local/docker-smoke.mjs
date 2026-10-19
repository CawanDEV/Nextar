// Run only against a dedicated development stack. Creates one clearly labelled test product.
import assert from 'node:assert/strict';
const base=process.env.SMOKE_BASE_URL||'http://localhost:8080';
async function request(path,method='GET',body){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;}
const health=await request('/health');assert.equal(health.database,'postgresql');
const sku='CI-'+Date.now(),p=await request('/api/v1/products','POST',{sku,name:'Produto TESTE Docker',description:'Produto sintético criado pelo smoke test',unit:'un',quantity:5,min_quantity:1,price:19.9});
await request('/api/v1/bot/preview','POST',{text:'/cancelar'});
const added=await request('/api/v1/bot/preview','POST',{text:`/comprar ${sku} 2`});assert.match(added.reply,/Adicionei 2/);
const reply=await request('/api/v1/bot/preview','POST',{text:'/finalizar'}),token=reply.reply.match(/checkout\/([a-f0-9]{64})/)[1];
const payment={holder:'CLIENTE TESTE',number:'4242424242424242',expiry:'12/30',cvc:'123'};
await request('/api/v1/checkout/'+token+'/pay','POST',payment);await request('/api/v1/checkout/'+token+'/pay','POST',payment);
const products=await request('/api/v1/products');assert.equal(products.find(x=>x.id===p.id).quantity,3);
const movements=await request('/api/v1/movements');assert.equal(movements.filter(x=>x.product_id===p.id&&x.type==='out').length,1);
assert.ok((await request('/api/v1/orders')).some(o=>o.status==='paid_test'&&o.items.some(i=>i.product_id===p.id)));
const website=await fetch('http://localhost:5173/api/v1/products');assert.ok(website.ok);assert.equal((await website.json()).find(x=>x.id===p.id).quantity,3);
console.log('Docker smoke OK: API Go, vendedor, checkout e interface compartilham o mesmo PostgreSQL.');
