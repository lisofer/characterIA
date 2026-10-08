'use strict';
// Persona Studio 3: servidor Node compatible con Railway; sin dependencias.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const PORT=Number(process.env.PORT)||3000;
const FISH_URL='https://api.fish.audio/v1/tts';
const common={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
function pack(value){
 const o=[];const put=x=>o.push(x&255);const bytes=b=>{for(const x of b)put(x)};
 const uint=(n,len)=>{for(let k=len-1;k>=0;k--)put(Math.floor(n/256**k))};
 function enc(v){
  if(v==null){put(0xc0);return}
  if(typeof v==='boolean'){put(v?0xc3:0xc2);return}
  if(typeof v==='number'){
   if(Number.isInteger(v)&&v>=0&&v<128){put(v);return}
   if(Number.isInteger(v)&&v>=-32&&v<0){put(256+v);return}
   if(Number.isInteger(v)&&v>=0&&v<=65535){if(v<=255){put(0xcc);uint(v,1)}else{put(0xcd);uint(v,2)}return}
   put(0xcb);const b=Buffer.allocUnsafe(8);b.writeDoubleBE(v);bytes(b);return;
  }
  if(typeof v==='string'){
   const b=Buffer.from(v,'utf8');if(b.length<=31)put(0xa0|b.length);
   else if(b.length<=255){put(0xd9);uint(b.length,1)}
   else if(b.length<=65535){put(0xda);uint(b.length,2)}
   else{put(0xdb);uint(b.length,4)}
   bytes(b);return;
  }
  if(Buffer.isBuffer(v)||v instanceof Uint8Array){
   const b=Buffer.from(v);if(b.length<=255){put(0xc4);uint(b.length,1)}
   else if(b.length<=65535){put(0xc5);uint(b.length,2)}
   else{put(0xc6);uint(b.length,4)}
   bytes(b);return;
  }
  if(Array.isArray(v)){if(v.length<=15)put(0x90|v.length);else{put(0xdc);uint(v.length,2)}v.forEach(enc);return}
  if(typeof v==='object'){const keys=Object.keys(v).filter(k=>v[k]!=null);if(keys.length<=15)put(0x80|keys.length);else{put(0xde);uint(keys.length,2)}for(const key of keys){enc(key);enc(v[key])}return}
  throw Error('Tipo no compatible con MessagePack');
 }
 enc(value);return Buffer.from(o);
}
function json(res,status,obj){res.writeHead(status,{...common,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj))}
async function readJson(req,limit=17000000){
 return new Promise((resolve,reject)=>{
  const buffers=[];let bytes=0;let rejected=false;
  req.on('data',part=>{bytes+=part.length;if(bytes>limit){if(!rejected){rejected=true;reject(Error('Solicitud demasiado grande'))}req.destroy();return}buffers.push(part)});
  req.on('end',()=>{if(rejected)return;try{resolve(JSON.parse(Buffer.concat(buffers).toString('utf8')))}catch{reject(Error('JSON inválido'))}});
  req.on('error',reject);
 });
}
async function tts(req,res){
 let body;try{body=await readJson(req)}catch(e){if(!res.destroyed)json(res,413,{error:e.message});return}
 if(!body||typeof body!=='object')return json(res,400,{error:'Solicitud inválida'});
 const key=String(req.headers['x-fish-key']||process.env.FISH_API_KEY||'').trim();
 if(!key)return json(res,401,{error:'Falta la Fish Audio API key. Ingresala en Voz.'});
 if(typeof body.text!=='string'||!body.text.trim()||body.text.length>4500)return json(res,400,{error:'El texto debe tener entre 1 y 4500 caracteres.'});
 const speed=Math.max(.5,Math.min(2,Number(body.speed)||1));
 const temperature=Number.isFinite(Number(body.temperature))?Math.max(0,Math.min(1,Number(body.temperature))):.7;
 const latency=['low','balanced','normal'].includes(body.latency)?body.latency:'balanced';
 const data={text:body.text,format:'mp3',latency,chunk_length:150,prosody:{speed,volume:0,normalize_loudness:true},temperature,top_p:.7};
 if(body.reference_id)data.reference_id=String(body.reference_id).slice(0,128);
 else if(body.reference_audio){
  if(typeof body.reference_text!=='string'||!body.reference_text.trim())return json(res,400,{error:'Falta la transcripción exacta de la muestra.'});
  const audio=Buffer.from(String(body.reference_audio),'base64');
  if(!audio.length||audio.length>12000000)return json(res,400,{error:'Muestra de voz vacía o demasiado grande.'});
  data.references=[{audio,text:body.reference_text.slice(0,5000)}];
 }
 try{
  const upstream=await fetch(FISH_URL,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/msgpack',model:'s2.1-pro-free'},body:pack(data),signal:AbortSignal.timeout(90000)});
  if(!upstream.ok)return json(res,upstream.status,{error:(await upstream.text()).slice(0,700)||upstream.statusText});
  const audio=Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200,{...common,'Content-Type':'audio/mpeg'});res.end(audio);
 }catch(e){if(!res.headersSent&&!res.destroyed)json(res,502,{error:'Fish no respondió: '+e.message});else res.end()}
}
const html=fs.readFileSync(path.join(__dirname,'index.html'));
const server=http.createServer((req,res)=>{
 const route=(req.url||'/').split('?')[0];
 if(req.method==='GET'&&(route==='/'||route==='/index.html')){res.writeHead(200,{...common,'Content-Type':'text/html; charset=utf-8'});res.end(html);return}
 if(req.method==='GET'&&route==='/api/health'){json(res,200,{ok:true,model:'s2.1-pro-free',fishKeyConfigured:!!process.env.FISH_API_KEY});return}
 if(req.method==='POST'&&route==='/api/fish/tts'){tts(req,res);return}
 json(res,404,{error:'Ruta inexistente'});
});
server.listen(PORT,'0.0.0.0',()=>console.log('Persona Studio: http://localhost:'+PORT));
module.exports={pack,server};
