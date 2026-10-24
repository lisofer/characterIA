'use strict';
// Supabase Storage (private bucket): durable mirror for Render Free.
// API keys are used only by Node.js, never sent to the browser.
const fs=require('fs');
const path=require('path');
const base=String(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
const key=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
const enabled=!!(base&&key);
const bucket=process.env.SUPABASE_BUCKET||'mi-primer-cv-privado';
const namespace='appdata';
let ready=false;
const headers=()=>({apikey:key,Authorization:'Bearer '+key});
function safeRelative(name){
 if(name.split('/').some(part=>part==='.'||part==='..')||!/^(settings\.json|assets\/[A-Za-z0-9_.-]+|sessions\/[a-f0-9-]{36}\.json|cvs\/[a-f0-9-]{36}\.pdf)$/.test(name))
  throw Error('Nombre de archivo no autorizado para almacenamiento externo');
 return name;
}
function urlFor(object){return base+'/storage/v1/'+object}
function objKey(filename){return namespace+'/'+safeRelative(filename)}
async function remote(method,url,body=null,contentType=null,missingOK=false){
 const h=headers();if(contentType)h['Content-Type']=contentType;
 const response=await fetch(url,{method,headers:h,body,signal:AbortSignal.timeout(20000)});
 if(missingOK&&response.status===404)return null;
 if(!response.ok){const detail=(await response.text()).slice(0,350);throw Error('Almacenamiento Supabase: '+response.status+' '+detail)}
 return response;
}
function configured(){return enabled}
function active(){return ready}
async function prepare(root){
 if(Boolean(base)!==Boolean(key))throw Error('Configurá tanto SUPABASE_URL como SUPABASE_SERVICE_ROLE_KEY en Render');
 if(!enabled)return {enabled:false,restored:0};
 if(!/^https:\/\/[a-z0-9.-]+$/i.test(base))throw Error('SUPABASE_URL debe ser una dirección HTTPS válida');
 const bucketEndpoint=urlFor('bucket/'+encodeURIComponent(bucket));
 let existing=await fetch(bucketEndpoint,{headers:headers(),signal:AbortSignal.timeout(15000)});
 if(existing.status===404){
  await remote('POST',urlFor('bucket'),JSON.stringify({id:bucket,name:bucket,public:false,file_size_limit:52428800}),'application/json');
 }else if(!existing.ok)throw Error('No se pudo acceder al bucket privado: '+existing.status);
 else {const data=await existing.json();if(data.public)throw Error('El bucket debe ser PRIVADO: '+bucket)}
 let restored=0;
 async function download(name){
  const rel=safeRelative(name);
  const r=await remote('GET',urlFor('object/authenticated/'+encodeURIComponent(bucket)+'/'+objKey(rel)),null,null,true);
  if(!r)return false;
  const local=path.join(root,...rel.split('/'));
  fs.mkdirSync(path.dirname(local),{recursive:true});
  fs.writeFileSync(local,Buffer.from(await r.arrayBuffer()));
  restored++;return true;
 }
 await download('settings.json');
 for(const dir of ['assets','sessions','cvs']){
  for(let offset=0;offset<3000;offset+=100){
   const endpoint=urlFor('object/list/'+encodeURIComponent(bucket));
   const response=await remote('POST',endpoint,JSON.stringify({prefix:namespace+'/'+dir,limit:100,offset}),'application/json');
   const entries=await response.json();
   for(const entry of entries){if(!entry.name||entry.id===null)continue;const rel=dir+'/'+entry.name;try{await download(rel)}catch(e){if(!/no autorizado/.test(e.message))throw e}}
   if(!Array.isArray(entries)||entries.length<100)break;
  }
 }
 ready=true;
 return {enabled:true,restored,bucket};
}
async function persist(root,filename){
 if(!enabled)return;
 if(!ready)throw Error('El almacenamiento persistente todavía no está disponible');
 const rel=safeRelative(filename),local=path.join(root,...rel.split('/'));
 const suffix=path.extname(rel).toLowerCase();
 const mime=suffix==='.png'?'image/png':suffix==='.pdf'?'application/pdf':suffix==='.json'?'application/json':suffix==='.txt'?'text/plain':suffix==='.bin'?'application/octet-stream':'application/octet-stream';
 const data=fs.readFileSync(local);
 const remotePath=urlFor('object/'+encodeURIComponent(bucket)+'/'+objKey(rel));
 const h={...headers(),'Content-Type':mime,'x-upsert':'true','Cache-Control':'no-store'};
 const r=await fetch(remotePath,{method:'POST',headers:h,body:data,signal:AbortSignal.timeout(25000)});
 if(!r.ok)throw Error('No se pudo guardar de forma persistente '+rel+': '+r.status+' '+(await r.text()).slice(0,160));
}
async function remove(filename){
 if(!enabled)return;
 if(!ready)throw Error('No está disponible el almacenamiento persistente');
 const rel=safeRelative(filename);
 await remote('DELETE',urlFor('object/'+encodeURIComponent(bucket)),JSON.stringify({prefixes:[objKey(rel)]}),'application/json');
}
module.exports={configured,active,prepare,persist,remove};
