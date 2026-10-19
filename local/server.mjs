import http from 'node:http';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,BusinessError} from './store.mjs';
import {Assistant} from './assistant.mjs';
import {runTelegram} from './telegram.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
async function body(req){let text='';for await(const part of req){text+=part;if(text.length>16_384)throw new BusinessError('Requisição muito grande.',413);}try{return JSON.parse(text||'{}');}catch{throw new BusinessError('JSON inválido.');}}
export function createApp({store=new Store(),config={}}={}){
 const assistant=new Assistant(store,config),status={state:'disabled',message:'Configure TELEGRAM_BOT_TOKEN no arquivo .env.',username:null};
 let tail=Promise.resolve();const queue=fn=>{const next=tail.then(fn);tail=next.catch(()=>{});return next;};
 const server=http.createServer(async(req,res)=>{
  // O modo de testes é local. Não publicar este servidor administrativo na internet.
  const permittedHosts=new Set(['localhost','127.0.0.1','[::1]']);
  let url;try{url=new URL(req.url,'http://'+req.headers.host);}catch{return json(res,400,{error:'URL inválida.'});}
  if(!permittedHosts.has(url.hostname))return json(res,403,{error:'Modo local: endereço não permitido.'});
  if(req.headers.origin&&!['http://localhost:8080','http://127.0.0.1:8080','http://localhost:5173','http://127.0.0.1:5173',config.baseUrl].includes(req.headers.origin))return json(res,403,{error:'Origem não permitida.'});
  try{
   const data=['POST','PUT','DELETE'].includes(req.method)?await body(req):{};
   if(config.apiTarget&&url.pathname.startsWith('/api/')&&!/^\/api\/v1\/(bot|orders|checkout)(?:\/|$)/.test(url.pathname)){
    const upstream=await fetch(config.apiTarget+url.pathname+url.search,{method:req.method,headers:{'Content-Type':'application/json'},body:['POST','PUT','DELETE'].includes(req.method)?JSON.stringify(data):undefined,signal:AbortSignal.timeout(15000)});
    res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json','Cache-Control':'no-store'});res.end(await upstream.text());return;
   }
   await queue(async()=>{
    const path=url.pathname,method=req.method;
    if(method==='GET'&&path==='/health'){if(config.apiTarget)await store.get('SELECT 1');return json(res,200,{status:'ok',database:config.apiTarget?'postgresql':'sqlite',mode:config.apiTarget?'docker-test':'local-test'});}
    if(method==='GET'&&path==='/api/v1/bot/status')return json(res,200,{...status,ai_enabled:!!config.apiKey,mode:'test'});
    if(method==='POST'&&path==='/api/v1/bot/preview'){
     if(typeof data.text!=='string'||!data.text.trim()||data.text.length>2000)throw new BusinessError('Digite até 2.000 caracteres.');
     return json(res,200,{reply:await assistant.reply('preview',data.text,'Cliente de teste')});
    }
    if(method==='GET'&&path==='/api/v1/orders')return json(res,200,await store.orders());
    const checkout=path.match(/^\/api\/v1\/checkout\/([a-f0-9]{64})(\/pay)?$/);
    if(checkout){
     if(method==='GET'&&!checkout[2]){const o=await store.publicOrder(checkout[1]);return json(res,200,{id:o.id,customer_name:o.customer_name,items:o.items,total_cents:o.total_cents,status:o.status,expired:o.expired,expires_at:o.expires_at});}
     if(method==='POST'&&checkout[2]){const o=await store.pay(checkout[1],data);return json(res,200,{id:o.id,status:o.status,total_cents:o.total_cents});}
     throw new BusinessError('Método não permitido.',405);
    }
    if(path==='/api/v1/products'&&method==='GET'){let p=store.products();const q=(url.searchParams.get('q')||'').toLowerCase();p=p.filter(p=>(p.name+' '+p.sku).toLowerCase().includes(q));if(url.searchParams.get('low_stock')==='true')p=p.filter(p=>p.quantity<=p.min_quantity);return json(res,200,p);}
    if(path==='/api/v1/products'&&method==='POST')return json(res,201,store.saveProduct(data));
    const product=path.match(/^\/api\/v1\/products\/([\w-]+)$/);
    if(product&&method==='PUT')return json(res,200,store.saveProduct(data,product[1]));
    if(product&&method==='DELETE'){
     if(!store.get('SELECT id FROM products WHERE id=?',product[1]))throw new BusinessError('Produto não encontrado.',404);
     if(store.get('SELECT id FROM movements WHERE product_id=?',product[1]))throw new BusinessError('Produto com movimentações não pode ser excluído.',409);
     store.transaction(()=>{store.run('DELETE FROM products WHERE id=?',product[1]);store.audit('product.deleted','product',product[1],'Produto excluído');});return json(res,200,{ok:true});
    }
    if(path==='/api/v1/movements'&&method==='GET')return json(res,200,store.all('SELECT m.*,p.name product_name,p.sku FROM movements m JOIN products p ON p.id=m.product_id ORDER BY m.created_at DESC LIMIT 200'));
    if(path==='/api/v1/movements'&&method==='POST')return json(res,201,store.movement(data));
    if(path==='/api/v1/logs'&&method==='GET')return json(res,200,store.all('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200'));
    if(path==='/api/v1/suppliers'&&method==='GET')return json(res,200,store.all('SELECT * FROM suppliers ORDER BY name'));
    const supplier=path.match(/^\/api\/v1\/suppliers\/([\w-]+)$/);
    if((path==='/api/v1/suppliers'&&method==='POST')||(supplier&&method==='PUT')){
     if(!data.name?.trim())throw new BusinessError('Nome é obrigatório.');const id=supplier?.[1]||randomUUID();
     if(supplier&&!store.get('SELECT id FROM suppliers WHERE id=?',id))throw new BusinessError('Fornecedor não encontrado.',404);
     store.transaction(()=>{
      store.run('INSERT INTO suppliers(id,name,contact_name,email,phone,notes,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,contact_name=excluded.contact_name,email=excluded.email,phone=excluded.phone,notes=excluded.notes',id,data.name,data.contact_name||'',data.email||'',data.phone||'',data.notes||'',new Date().toISOString());
      store.audit(supplier?'supplier.updated':'supplier.created','supplier',id,'Fornecedor: '+data.name);
     });return json(res,supplier?200:201,store.get('SELECT * FROM suppliers WHERE id=?',id));
    }
    if(supplier&&method==='DELETE'){
     if(!store.get('SELECT id FROM suppliers WHERE id=?',supplier[1]))throw new BusinessError('Fornecedor não encontrado.',404);
     if(store.get('SELECT id FROM products WHERE supplier_id=?',supplier[1]))throw new BusinessError('Fornecedor associado a produtos.',409);
     store.transaction(()=>{store.run('DELETE FROM suppliers WHERE id=?',supplier[1]);store.audit('supplier.deleted','supplier',supplier[1],'Fornecedor excluído');});return json(res,200,{ok:true});
    }
    if(path.startsWith('/api/'))return json(res,404,{error:'Recurso não encontrado.'});
    if(method!=='GET')return json(res,405,{error:'Método não permitido.'});
    const dist=resolve(root,'frontend/dist'),file=resolve(dist,'.'+path),target=file.startsWith(dist+sep)&&existsSync(file)&&extname(file)?file:resolve(dist,'index.html');
    if(!existsSync(target))return json(res,503,{error:'Compile o site com npm run setup; depois abra http://localhost:8080.'});
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[extname(target)]||'application/octet-stream','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(readFileSync(target));
   });
  }catch(e){json(res,e.status|| (e.code?.startsWith('ERR_SQLITE')?409:500),{error:e.status?e.message:e.code?.startsWith('ERR_SQLITE')?'Não foi possível gravar. Confira SKU único e relacionamentos.':'Não foi possível concluir a operação.'});}
 });
 return {server,store,assistant,status,queue};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(!process.env.DATABASE_URL)mkdirSync(resolve(root,'local/data'),{recursive:true});
 const port=Number(process.env.PORT||8080),config={baseUrl:process.env.PUBLIC_BASE_URL||`http://localhost:${port}`,storeName:process.env.STORE_NAME||'Nextar',policies:process.env.STORE_POLICIES||'Ambiente de testes. Retirada simulada, sem frete, entrega ou cobrança real.',contact:process.env.STORE_CONTACT,apiKey:process.env.OPENAI_API_KEY,model:process.env.OPENAI_MODEL};
 config.apiTarget=process.env.API_TARGET;
 const db=process.env.DATABASE_URL?await (await import('./postgres-store.mjs')).PostgresStore.open(process.env.DATABASE_URL):new Store(resolve(root,'local/data/nextar.sqlite'));
 const app=createApp({store:db,config}),controller=new AbortController();
 app.server.listen(port,process.env.BIND_HOST||'127.0.0.1',()=>console.log(`Nextar TESTE: http://localhost:${port} | ${process.env.DATABASE_URL?'PostgreSQL compartilhado':'SQLite local'} | sem cobrança real`));
 if(process.env.TELEGRAM_BOT_TOKEN)void runTelegram({...app,token:process.env.TELEGRAM_BOT_TOKEN,allowedIds:(process.env.TELEGRAM_ALLOWED_USER_IDS||'').split(',').filter(Boolean),signal:controller.signal});
 const stop=()=>{controller.abort();app.server.close(async()=>{await db.close?.();process.exit(0)});setTimeout(()=>process.exit(0),1500).unref();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
