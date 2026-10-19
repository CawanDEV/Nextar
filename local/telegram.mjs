import {setTimeout as delay} from 'node:timers/promises';
export function telegramClient(token,fetcher=fetch){return async(method,payload={})=>{
 try{const response=await fetcher(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(40_000)});const data=await response.json();if(!response.ok||!data.ok)throw Error('Telegram indisponível ou credencial inválida.');return data.result;}
 catch{throw Error('Não foi possível acessar o Telegram. Confira conexão e token.');}
};}
export async function processUpdate(store,assistant,update,queue){
 const m=update.message;if(!m?.text||m.chat.type!=='private')return;
 return queue(async()=>{
  const existing=await store.get('SELECT * FROM updates WHERE id=?',update.update_id);if(existing)return existing;
  // O efeito comercial e a resposta são persistidos juntos antes de confirmar o offset.
  await store.db.exec('BEGIN IMMEDIATE');store.depth=1;
  try{let reply;try{reply=await assistant.reply(m.chat.id,m.text,m.from?.first_name||'Cliente');}catch(e){if(!e.status)throw e;reply=e.message;}
   await store.run('INSERT INTO updates(id,reply,chat_id) VALUES(?,?,?)',update.update_id,reply,String(m.chat.id));await store.db.exec('COMMIT');return store.get('SELECT * FROM updates WHERE id=?',update.update_id);
  }catch(e){await store.db.exec('ROLLBACK');throw e;}finally{store.depth=0;}
 });
}
export async function runTelegram({store,assistant,token,allowedIds=[],queue,signal,status}){
 const call=telegramClient(token);
 while(!signal.aborted){
  try{
   const me=await call('getMe');const webhook=await call('getWebhookInfo');
   if(webhook.url){status.state='webhook_conflict';status.message='Este bot já tem webhook. Remova-o antes de usar o modo local; nenhuma configuração foi sobrescrita.';return;}
   status.state='connected';status.username=me.username;status.message='Conectado por long polling';
   while(!signal.aborted){
    const offset=Number((await queue(async()=>store.get("SELECT value FROM meta WHERE key='telegram_offset'")))?.value||0);
    const updates=await call('getUpdates',{offset,timeout:25,allowed_updates:['message']});
    for(const u of updates){
     const m=u.message;
     if(m?.text&&m.chat.type==='private'&&(!allowedIds.length||allowedIds.includes(String(m.from?.id))))await processUpdate(store,assistant,u,queue);
     await queue(async()=>store.run("INSERT INTO meta VALUES('telegram_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(u.update_id+1)));
    }
    const pending=await queue(async()=>store.all('SELECT * FROM updates WHERE sent=0 ORDER BY id'));
    for(const item of pending){
     // Respostas longas respeitam o limite do Telegram. Uma falha pode repetir a mensagem, nunca a venda.
     for(let i=0;i<item.reply.length;i+=3500)await call('sendMessage',{chat_id:item.chat_id,text:item.reply.slice(i,i+3500)});
     await queue(async()=>store.run('UPDATE updates SET sent=1 WHERE id=?',item.id));
    }
   }
  }catch{status.state='error';status.message='Telegram indisponível. Confira token, internet e se outra instância está usando o bot.';if(!signal.aborted)await delay(5000,undefined,{signal}).catch(()=>{});}
 }
}
