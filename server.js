'use strict';
// Persona Studio: acceso privado + proxies Gemini / Fish Audio. Sin dependencias.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const cloud=require('./cloud-store');
const {setupLiveRelay}=require('./live-relay');
const {createTikTokChat}=require('./tiktok-chat');
const PORT = Number(process.env.PORT) || 3000;
const FISH_ENDPOINT = 'https://api.fish.audio/v1/tts';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const TOKEN = String(process.env.APP_ACCESS_TOKEN || '').trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
const GEMINI_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const FISH_KEY = String(process.env.FISH_API_KEY || '').trim();
const ready = TOKEN.length >= 24 && SESSION_SECRET.length >= 32;
const signingKey = ready ? crypto.createHmac('sha256', SESSION_SECRET).update('persona-studio-session:' + TOKEN).digest() : null;
const liveRelay=ready?setupLiveRelay(signingKey):null;
const tiktokChat=createTikTokChat();
const cookieName = 'persona_session';
const ttlMs = 7 * 86400 * 1000;
const attempts = new Map();
const quotas = new Map();
const baseHeaders = {
 'Cache-Control':'no-store',
 'X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'no-referrer',
 'X-Frame-Options':'DENY',
 'Permissions-Policy':'camera=(), geolocation=(), microphone=(self)',
 'Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};
function respond(res, status, body, extra={}) {
 if(res.destroyed || res.headersSent) return;
 res.writeHead(status,{...baseHeaders,'Content-Type':'application/json; charset=utf-8',...extra});
 res.end(JSON.stringify(body));
}
function page(res,status,html){res.writeHead(status,{...baseHeaders,'Content-Type':'text/html; charset=utf-8'});res.end(html)}
function correct(actual,expected){const a=Buffer.from(String(actual)),b=Buffer.from(String(expected));return a.length===b.length && crypto.timingSafeEqual(a,b)}
function mac(payload){return crypto.createHmac('sha256',signingKey).update(payload).digest('base64url')}
function makeSession(){const payload=Buffer.from(JSON.stringify({t:Date.now(),n:crypto.randomBytes(16).toString('hex')})).toString('base64url');return payload+'.'+mac(payload)}
function cookie(req,val,maxAge=604800){const secure=(req.socket.encrypted || req.headers['x-forwarded-proto']==='https'||process.env.NODE_ENV==='production')?'; Secure':'';return cookieName+'='+val+'; Path=/; HttpOnly; SameSite=Strict'+secure+'; Max-Age='+maxAge}
function authenticated(req){if(!ready)return false;const m=String(req.headers.cookie||'').match(/(?:^|;\s*)persona_session=([^;]+)/);if(!m)return false;const [payload,signature,...extra]=m[1].split('.');if(extra.length||!payload||!signature||!correct(signature,mac(payload)))return false;try{const d=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));return typeof d.t==='number' && d.t<=Date.now()+60000 && Date.now()-d.t>=0 && Date.now()-d.t<ttlMs}catch{return false}}
function csrfSafe(req){const origin=req.headers.origin;if(origin){try{if(new URL(origin).host!==req.headers.host)return false}catch{return false}}return req.headers['sec-fetch-site']!=='cross-site'}
function quotaCheck(req,max=120,windowMs=15*60000){const key=req.socket.remoteAddress||'unknown';const now=Date.now();let q=quotas.get(key);if(!q||now-q.start>windowMs){q={start:now,used:0};quotas.set(key,q)}q.used++;return q.used<=max}
async function jsonBody(req,limit=22000000){if(!String(req.headers['content-type']||'').startsWith('application/json'))throw Error('Se requiere JSON');const chunks=[];let total=0;for await(const chunk of req){total+=chunk.length;if(total>limit)throw Error('Solicitud demasiado grande');chunks.push(chunk)}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Error('JSON inválido')}}
async function binaryBody(req,limit=20000000){
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(Error('Archivo demasiado grande'),{status:413});chunks.push(chunk)}
 return Buffer.concat(chunks);
}
function cloudError(res,e){respond(res,e.status||500,{error:e.message,currentRevision:e.currentRevision??undefined})}
const loginPage=fs.readFileSync(path.join(__dirname,'login.html'));
const appHtml=fs.readFileSync(path.join(__dirname,'index.html'));
const cloudSyncScript=fs.readFileSync(path.join(__dirname,'cloud-sync.js'));
const cloudMergeScript=fs.readFileSync(path.join(__dirname,'cloud-merge.js'));
const musicRuntimeScript=fs.readFileSync(path.join(__dirname,'music-runtime.js'));
const tiktokChatRuntimeScript=fs.readFileSync(path.join(__dirname,'tiktok-chat-runtime.js'));

function pack(value){
 const out=[];const put=n=>out.push(n&255);const bytes=b=>{for(const v of b)put(v)};const uint=(n,len)=>{for(let i=len-1;i>=0;i--)put(Math.floor(n/256**i))};
 function enc(v){
  if(v==null){put(0xc0);return}if(typeof v==='boolean'){put(v?0xc3:0xc2);return}
  if(typeof v==='number'){if(Number.isInteger(v)&&v>=0&&v<128){put(v);return}if(Number.isInteger(v)&&v>=-32&&v<0){put(256+v);return}if(Number.isInteger(v)&&v>=0&&v<=65535){if(v<=255){put(0xcc);uint(v,1)}else{put(0xcd);uint(v,2)}return}put(0xcb);const b=Buffer.allocUnsafe(8);b.writeDoubleBE(v);bytes(b);return}
  if(typeof v==='string'){const b=Buffer.from(v,'utf8');if(b.length<=31)put(0xa0|b.length);else if(b.length<=255){put(0xd9);uint(b.length,1)}else if(b.length<=65535){put(0xda);uint(b.length,2)}else{put(0xdb);uint(b.length,4)}bytes(b);return}
  if(Buffer.isBuffer(v)||v instanceof Uint8Array){const b=Buffer.from(v);if(b.length<=255){put(0xc4);uint(b.length,1)}else if(b.length<=65535){put(0xc5);uint(b.length,2)}else{put(0xc6);uint(b.length,4)}bytes(b);return}
  if(Array.isArray(v)){if(v.length<=15)put(0x90|v.length);else{put(0xdc);uint(v.length,2)}v.forEach(enc);return}
  if(typeof v==='object'){const keys=Object.keys(v).filter(k=>v[k]!=null);if(keys.length<=15)put(0x80|keys.length);else{put(0xde);uint(keys.length,2)}for(const key of keys){enc(key);enc(v[key])}return}throw Error('Tipo MessagePack no compatible')
 }enc(value);return Buffer.from(out);
}
function failRemote(res,upstream,name){return upstream.text().then(text=>respond(res,upstream.status,{error:name+' ('+upstream.status+'): '+text.slice(0,700)}))}
async function fish(req,res){
 if(!FISH_KEY)return respond(res,503,{error:'Configurá FISH_API_KEY en Railway Variables.'});
 let body;try{body=await jsonBody(req)}catch(e){return respond(res,400,{error:e.message})}
 if(typeof body.text!=='string'||!body.text.trim()||body.text.length>4500)return respond(res,400,{error:'Texto inválido (máximo 4500 caracteres).'});
 const speed=Math.max(.5,Math.min(2,Number(body.speed)||1));const temperature=Number.isFinite(+body.temperature)?Math.max(0,Math.min(1,+body.temperature)):.7;
 const data={text:body.text,format:'mp3',latency:['low','balanced','normal'].includes(body.latency)?body.latency:'balanced',chunk_length:150,prosody:{speed,volume:0,normalize_loudness:true},temperature,top_p:.7};
 if(body.reference_id)data.reference_id=String(body.reference_id).slice(0,128);
 else if(body.reference_audio){if(typeof body.reference_text!=='string'||!body.reference_text.trim())return respond(res,400,{error:'Falta la transcripción exacta de la muestra.'});const audio=Buffer.from(String(body.reference_audio),'base64');if(!audio.length||audio.length>12000000)return respond(res,400,{error:'Muestra de audio demasiado grande.'});data.references=[{audio,text:body.reference_text.slice(0,5000)}]}
 try{const upstream=await fetch(FISH_ENDPOINT,{method:'POST',headers:{Authorization:'Bearer '+FISH_KEY,'Content-Type':'application/msgpack',model:'s2.1-pro-free'},body:pack(data),signal:AbortSignal.timeout(90000)});if(!upstream.ok)return failRemote(res,upstream,'Fish');const audio=Buffer.from(await upstream.arrayBuffer());res.writeHead(200,{...baseHeaders,'Content-Type':'audio/mpeg'});res.end(audio)}catch(e){respond(res,502,{error:'Fish no respondió: '+e.message})}
}
function geminiURL(model,stream){if(typeof model!=='string'||!(/^[a-zA-Z0-9_.-]{3,90}$/).test(model))return null;return GEMINI_BASE+encodeURIComponent(model)+(stream?':streamGenerateContent?alt=sse':':generateContent')}
async function gemini(req,res,stream){
 if(!GEMINI_KEY)return respond(res,503,{error:'Configurá GEMINI_API_KEY en Railway Variables.'});
 let body;try{body=await jsonBody(req,23000000)}catch(e){return respond(res,400,{error:e.message})}
 const url=geminiURL(body.model,stream);if(!url)return respond(res,400,{error:'Modelo inválido.'});
 const payload=body.payload;
 if(!payload||typeof payload!=='object'||!Array.isArray(payload.contents)||payload.contents.length>25)return respond(res,400,{error:'Solicitud Gemini inválida.'});
 const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(),120000);
 const onClose=()=>ctrl.abort();res.once('close',onClose);
 try{
  const upstream=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':GEMINI_KEY},body:JSON.stringify(payload),signal:ctrl.signal});
  if(!upstream.ok){res.off('close',onClose);return failRemote(res,upstream,'Gemini')}
  if(!stream){const result=await upstream.text();res.writeHead(200,{...baseHeaders,'Content-Type':'application/json; charset=utf-8'});res.end(result);return}
  res.writeHead(200,{...baseHeaders,'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no'});
  if(upstream.body)await new Promise((resolve,reject)=>Readable.fromWeb(upstream.body).on('error',reject).on('end',resolve).pipe(res));else res.end();
 }catch(e){if(!ctrl.signal.aborted)respond(res,502,{error:'Gemini no respondió: '+e.message})}
 finally{clearTimeout(timeout);res.off('close',onClose)}
}
const server=http.createServer(async(req,res)=>{
 const route=(req.url||'/').split('?')[0];
 if(req.method==='GET'&&route==='/healthz')return respond(res,200,{ok:true});
 if(!ready)return page(res,503,'<!doctype html><html lang="es"><meta name="viewport" content="width=device-width"><h1>Configuración pendiente</h1><p>Agregá APP_ACCESS_TOKEN (24+ caracteres) y SESSION_SECRET (32+ caracteres) en Railway Variables.</p></html>');
 // Enlace de solo lectura para la fuente web de TikTok. No utiliza cookies ni
 // comparte los controles de producción; la URL contiene una clave aleatoria.
 if(req.method==='GET'&&(route==='/live'||route==='/api/live/state'||route.startsWith('/api/live/asset/'))){
  const query=new URL(req.url,'https://localhost').searchParams;
  if(!liveRelay.valid(query.get('key')))return respond(res,403,{error:'Enlace LIVE no autorizado'});
  if(route==='/live'){
   const headers={...baseHeaders,'Content-Type':'text/html; charset=utf-8'};
   delete headers['X-Frame-Options'];
   headers['Content-Security-Policy']=headers['Content-Security-Policy'].replace("frame-ancestors 'none'","frame-ancestors *");
   res.writeHead(200,headers);res.end(liveRelay.page);return;
  }
  if(route==='/api/live/state')try{return respond(res,200,liveRelay.getState())}catch(e){return cloudError(res,e)}
  if(route.startsWith('/api/live/asset/'))try{
   const resource=liveRelay.asset(route.slice('/api/live/asset/'.length));
   if(!resource)return respond(res,404,{error:'Imagen no disponible para esta transmisión'});
   res.writeHead(200,{...baseHeaders,'Content-Type':resource.type,'Content-Length':resource.data.length});
   res.end(resource.data);return;
  }catch(e){return cloudError(res,e)}
 }
 if(req.method==='GET'&&route==='/login'){if(authenticated(req)){res.writeHead(302,{...baseHeaders,Location:'/'});res.end();return}return page(res,200,loginPage)}
 if(req.method==='POST'&&route==='/api/auth/login'){
  if(!csrfSafe(req))return respond(res,403,{error:'Origen no autorizado'});
  const key=req.socket.remoteAddress||'unknown';const now=Date.now();let a=attempts.get(key);if(!a||now-a.start>15*60000){a={start:now,count:0};attempts.set(key,a)}
  if(a.count>=8)return respond(res,429,{error:'Demasiados intentos. Esperá 15 minutos.'});
  let body;try{body=await jsonBody(req,2000)}catch{return respond(res,400,{error:'Solicitud inválida'})}
  if(typeof body.token!=='string'||!correct(body.token,TOKEN)){a.count++;return respond(res,401,{error:'Token incorrecto'})}
  attempts.delete(key);return respond(res,200,{ok:true},{'Set-Cookie':cookie(req,makeSession())});
 }
 if(!authenticated(req)){if(req.method==='GET'&&['/','/index.html'].includes(route)){res.writeHead(302,{...baseHeaders,Location:'/login'});res.end();return}return respond(res,401,{error:'Sesión no autorizada. Ingresá con tu token.'})}
 if(['POST','PUT','DELETE'].includes(req.method)&&!csrfSafe(req))return respond(res,403,{error:'Origen no autorizado'});
 if(req.method==='POST'&&route==='/api/auth/logout')return respond(res,200,{ok:true},{'Set-Cookie':cookie(req,'',0)});
 if(req.method==='GET'&&(route==='/'||route==='/index.html'))return page(res,200,appHtml);
 if(req.method==='GET'&&(route==='/cloud-sync.js'||route==='/cloud-merge.js'||route==='/music-runtime.js'||route==='/tiktok-chat-runtime.js')){
  res.writeHead(200,{...baseHeaders,'Content-Type':'text/javascript; charset=utf-8'});
  res.end(route==='/cloud-sync.js'?cloudSyncScript:route==='/cloud-merge.js'?cloudMergeScript:route==='/music-runtime.js'?musicRuntimeScript:tiktokChatRuntimeScript);return;
 }
 if(req.method==='GET'&&route==='/api/health')return respond(res,200,{ok:true,model:'s2.1-pro-free',fishKeyConfigured:!!FISH_KEY,geminiKeyConfigured:!!GEMINI_KEY,authenticated:true});
 if(req.method==='GET'&&route==='/api/live/link')return respond(res,200,{path:'/live?key='+liveRelay.key});
  // Solo el panel privado puede leer o controlar el puente del chat de TikTok.
  if(req.method==='GET'&&route==='/api/tiktok/chat')return respond(res,200,tiktokChat.snapshot());
  if(req.method==='POST'&&route==='/api/tiktok/chat/connect'){
   if(!quotaCheck(req,60))return respond(res,429,{error:'Demasiadas conexiones. Esperá unos minutos.'});
   try{
    const body=await jsonBody(req,1500);
    return respond(res,202,tiktokChat.start(body.username,{force:body.force===true}));
   }catch(e){return respond(res,e.status||400,{error:e.message})}
  }
  if(req.method==='POST'&&route==='/api/tiktok/chat/disconnect')return respond(res,200,tiktokChat.stop());
 // Las imágenes van por el almacenamiento permanente. Aquí llega solo el estado
 // ligero de la escena (varias veces por segundo durante el LIVE).
 if(req.method==='POST'&&route==='/api/live/scene'){
  try{return respond(res,200,liveRelay.accept(await jsonBody(req,65000)))}
  catch(e){return cloudError(res,e)}
 }
 if(['POST','PUT'].includes(req.method)&&!quotaCheck(req,240))return respond(res,429,{error:'Demasiadas solicitudes. Esperá unos minutos.'});
 // Datos privados: solo se accede con la sesión autenticada del propietario.
 if(req.method==='GET'&&route==='/api/cloud/status')return respond(res,200,cloud.status());
 if(req.method==='GET'&&route==='/api/cloud/state')try{return respond(res,200,cloud.readState())}catch(e){return cloudError(res,e)}
 if(req.method==='PUT'&&route==='/api/cloud/state'){
  try{return respond(res,200,cloud.updateState(await jsonBody(req,6000000)))}
  catch(e){return cloudError(res,e)}
 }
 if(route.startsWith('/api/cloud/assets/')){
  const hash=route.slice('/api/cloud/assets/'.length);
  if(req.method==='PUT')try{return respond(res,200,cloud.putAsset(hash,await binaryBody(req,100*1024*1024)))}
    catch(e){return cloudError(res,e)}
  if(req.method==='GET')try{
   const data=cloud.getAsset(hash);
   res.writeHead(200,{...baseHeaders,'Content-Type':'application/octet-stream','Content-Length':data.length});
   res.end(data);return;
  }catch(e){return cloudError(res,e)}
 }
 if(req.method==='POST'&&route==='/api/fish/tts')return fish(req,res);
 if(req.method==='POST'&&route==='/api/gemini/stream')return gemini(req,res,true);
 if(req.method==='POST'&&route==='/api/gemini/transcribe')return gemini(req,res,false);
 return respond(res,404,{error:'Ruta inexistente'});
});
server.listen(PORT,'0.0.0.0',()=>console.log('Persona Studio private listening on port '+PORT));
module.exports={server,pack,authenticated,geminiURL};
