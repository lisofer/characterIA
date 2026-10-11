/* Persona Studio: automatic, non-destructive synchronization between devices.
   All actual files live on the mounted persistent Railway volume, NOT GitHub. */
(()=>{
 'use strict';
 if(new URLSearchParams(location.search).get('output')==='1')return;
 const keys=['persona-studio-profiles-v3','persona-studio-profile-index-v3','persona-studio-duels-v1',
  'persona-studio-backgrounds-v1','persona-studio-global-v3','persona-studio-stage-share-v1',
  'persona-studio-duel-general-prompt-v1'];
 const LINK='persona-studio-cloud-linked-v1',REV='persona-studio-cloud-revision-v1',
       BASE='persona-studio-cloud-base-v2',FP='persona-studio-cloud-fingerprint-v1',
       DIRTY='persona-studio-cloud-assets-dirty-v1',PENDING='persona-studio-cloud-pending-apply-v1';
 const $=id=>document.getElementById(id),bridge=()=>window.PERSONA_CLOUD_BRIDGE;
 const merge=()=>window.PERSONA_CLOUD_MERGE;
 let available=false,working=false,timer=null,initialized=false,loadError=false;
 let base=null,lastRevision=0,lastFingerprint='';
 const persistent=key=>{try{return localStorage.getItem(key)}catch{return null}};
 const set=(key,value)=>localStorage.setItem(key,value);
 function status(msg,error=false){const e=$('cloudStatus');if(e){e.textContent=msg;e.style.color=error?'#ffc3a9':''}}
 function notice(msg,error=false){status(msg,error);if(error)bridge()?.notify?.(msg,true)}
 function values(){const out={};for(const key of keys){const value=persistent(key);if(value!==null)out[key]=value}return out}
 function same(a,b){return JSON.stringify(a)===JSON.stringify(b)}
 function parse(kv,key,fallback){try{return JSON.parse(kv?.[key]||'null')??fallback}catch{return fallback}}
 async function hash(bytes){const result=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(result)].map(n=>n.toString(16).padStart(2,'0')).join('')}
 async function fingerprint(kv){return hash(new TextEncoder().encode(JSON.stringify(kv)))}
 async function request(url,options={}){
  const response=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});
  if(!response.ok){
   const obj=await response.json().catch(()=>({}));
   const err=Error(obj.error||'Servidor '+response.status);err.status=response.status;throw err;
  }
  return response;
 }
 async function cloud(){return (await request('/api/cloud/state')).json()}
 async function db(){return new Promise((resolve,reject)=>{
  const r=indexedDB.open('persona-studio-sprites-v1',1);
  r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('sprites'))r.result.createObjectStore('sprites')};
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('No se puede abrir el almacenamiento de archivos del navegador.'));
 })}
 async function localFiles(){
  const database=await db();
  try{return await new Promise((resolve,reject)=>{
   const items=new Map(),tx=database.transaction('sprites','readonly'),cursor=tx.objectStore('sprites').openCursor();
   cursor.onsuccess=()=>{const item=cursor.result;if(item){
    if(typeof item.key==='string'&&item.value instanceof Blob)items.set(item.key,item.value);
    item.continue();
   }};
   cursor.onerror=()=>reject(Error('No se pudieron leer las imágenes.'));
   tx.oncomplete=()=>resolve(items);tx.onerror=()=>reject(Error('No se pudieron leer las voces y fondos.'));
  })}finally{database.close()}
 }
 async function restoreFiles(files){
  const database=await db();
  try{await new Promise((resolve,reject)=>{
   const tx=database.transaction('sprites','readwrite'),store=tx.objectStore('sprites');
   store.clear();for(const [key,blob] of files)store.put(blob,key);
   tx.oncomplete=resolve;tx.onerror=()=>reject(Error('No se pudieron restaurar los archivos.'));
  })}finally{database.close()}
 }
 async function manifestFromFiles(files){
  const manifest={},buffers=new Map();
  for(const [key,blob] of files){
   if(blob.size>((key==='music:background'||key.startsWith('music:track:'))?100*1024*1024:20000000))throw Error('El archivo '+key+' excede el límite de '+((key==='music:background'||key.startsWith('music:track:'))?'100 MB':'20 MB')+'.');
   const bytes=await blob.arrayBuffer(),sha=await hash(bytes);
   manifest[key]={hash:sha,type:blob.type||'application/octet-stream',size:blob.size};
   buffers.set(sha,bytes);
  }
  return {manifest,buffers};
 }
 function remember(revision,state,kv){
  base=JSON.parse(JSON.stringify(state));
  lastRevision=revision;
  set(LINK,'yes');set(REV,String(revision));
  try{set(BASE,JSON.stringify({revision,state}))}catch{localStorage.removeItem(BASE)}
  localStorage.removeItem(DIRTY);
  return fingerprint(kv).then(fp=>{lastFingerprint=fp;set(FP,fp)});
 }
 async function publish(snapshot,revision,buffers,remoteAssets){
  const remoteHashes=new Set(Object.values(remoteAssets||{}).map(a=>a.hash));
  for(const info of Object.values(snapshot.assets||{})){
   if(remoteHashes.has(info.hash))continue;
   const bytes=buffers?.get(info.hash);
   if(!bytes)throw Error('Falta el archivo local de '+info.hash.slice(0,10)+'; no se sobrescribió la nube.');
   await request('/api/cloud/assets/'+info.hash,{method:'PUT',
    headers:{'Content-Type':'application/octet-stream'},body:bytes});
   remoteHashes.add(info.hash);
  }
  return (await request('/api/cloud/state',{method:'PUT',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({baseRevision:revision,state:snapshot})})).json();
 }
 async function apply(snapshot,revision,localFingerprint){
  // Never overwrite changes made while the downloads/requests were running.
  if(await fingerprint(values())!==localFingerprint)return false;
  if(bridge()?.isBusy())return false;
  const files=new Map();
  const current=await localFiles();
  const currentManifest=await manifestFromFiles(current);
  const byHash=new Map();
  for(const [key,meta] of Object.entries(currentManifest.manifest))byHash.set(meta.hash,current.get(key));
  for(const [key,meta] of Object.entries(snapshot.assets||{})){
   let file=byHash.get(meta.hash);
   if(!file)file=new Blob([await(await request('/api/cloud/assets/'+meta.hash)).blob()],{type:meta.type||'application/octet-stream'});
   files.set(key,file);
  }
  // A change may have happened while the images were downloading.
  if(await fingerprint(values())!==localFingerprint||bridge()?.isBusy())return false;
  await restoreFiles(files);
  for(const key of keys){
   if(Object.prototype.hasOwnProperty.call(snapshot.kv,key))set(key,snapshot.kv[key]);
   else localStorage.removeItem(key);
  }
  await bridge().refresh();
  return true;
 }
 function delta(baseState,localState){
  // Only import the records actually edited on this device since its last sync.
  // Unchanged profiles from an outdated device must not resurrect deleted cloud records.
  if(!baseState)return localState;
  const result={schema:1,kv:{},assets:{}},l=localState.kv||{},prev=baseState.kv||{};
  const PRO='persona-studio-profiles-v3',IDX='persona-studio-profile-index-v3';
  const BG='persona-studio-backgrounds-v1',D='persona-studio-duels-v1';
  const p=parse(l,PRO,{}),bp=parse(prev,PRO,{}),idx=parse(l,IDX,[]);
  const profileDelta={};const indexDelta=[];
  const a=localState.assets||{},ba=baseState.assets||{};
  for(const [id,item] of Object.entries(p)){
   const keysForProfile=Object.keys(a).filter(k=>k.startsWith(id+':'));
   const assetChanged=keysForProfile.some(k=>!same(a[k],ba[k]));
   if(!same(item,bp[id])||assetChanged){
    profileDelta[id]=item;
    const label=idx.find(x=>x.id===id);if(label)indexDelta.push(label);
   }
  }
  // Changes to the displayed names count too.
  const bidx=parse(prev,IDX,[]);
  for(const item of idx){
   if(!same(item,bidx.find(x=>x.id===item.id))&&!indexDelta.some(x=>x.id===item.id))indexDelta.push(item);
  }
  result.kv[PRO]=JSON.stringify(profileDelta);
  result.kv[IDX]=JSON.stringify(indexDelta);
  const backgroundList=parse(l,BG,[]),oldBackgrounds=parse(prev,BG,[]);
  result.kv[BG]=JSON.stringify(backgroundList.filter(item=>!same(item,oldBackgrounds.find(x=>x.id===item.id))||
   !same(a['bg:'+item.id],ba['bg:'+item.id])));
  const topics=parse(l,D,{topics:[],activeId:null}),oldTopics=parse(prev,D,{topics:[],activeId:null});
  result.kv[D]=JSON.stringify({topics:(topics.topics||[]).filter(t=>!same(t,(oldTopics.topics||[]).find(x=>x.id===t.id))),activeId:topics.activeId});
  for(const k of keys)if(![PRO,IDX,BG,D].includes(k)&&l[k]!==prev[k]&&l[k]!==undefined)result.kv[k]=l[k];
  for(const [key,val] of Object.entries(a))if(!same(val,ba[key]))result.assets[key]=val;
  return result;
 }
 function changedSinceBase(localState){return !base||!same(localState.kv,base.kv)||persistent(DIRTY)==='yes'}
 function markAssetsDirty(){set(DIRTY,'yes');schedule()}
 function schedule(){
  if(!initialized||!available)return;
  if(timer)clearTimeout(timer);
  timer=setTimeout(()=>{timer=null;sync()},1500);
 }
 async function sync(){
  if(!available||working||!merge())return;
  working=true;
  try{
   const remote=await cloud();
   const pendingRaw=persistent(PENDING);
   if(pendingRaw&&remote.state){
    try{
     const pending=JSON.parse(pendingRaw);
     if(pending.revision===remote.revision&&pending.fingerprint===await fingerprint(values())){
      if(bridge()?.isBusy()){
       status('☁ Cambios en la nube: esperando que termine la intervención.');
       return;
      }
      const success=await apply(remote.state,remote.revision,pending.fingerprint);
      if(success){
       await remember(remote.revision,remote.state,values());
       localStorage.removeItem(PENDING);
       status('✓ Actualizado en todos los dispositivos · versión '+remote.revision);
       return;
      }
     }
    }catch(e){notice('⚠ Restauración pendiente: '+e.message,true);return}
    localStorage.removeItem(PENDING);
   }
   const capturedKV=values(),capturedFingerprint=await fingerprint(capturedKV);
   // Las versiones anteriores no conservaban la base: importar, nunca reemplazar.
   const linked=persistent(LINK)==='yes'&&Boolean(base);
   const rev=Number(persistent(REV)||0);
   if(linked&&remote.state&&remote.revision!==rev&&bridge()?.isBusy()){
    status('☁ Hay cambios para sincronizar cuando termine la intervención.');
    return;
   }
   const shouldScan=!linked||!base||persistent(DIRTY)==='yes';
   const files=shouldScan?await localFiles():null;
   const built=files?await manifestFromFiles(files):null;
   const localState={schema:1,kv:capturedKV,assets:built?.manifest||base?.assets||{}};
   let next,shouldApply=false;
   if(!remote.state){
    next=localState;
    status('☁ Guardando tu biblioteca en Railway…');
   }else if(!linked){
    if(merge().meaningful(localState)){
     next=merge().merge(remote.state,localState).state;
     status('☁ Reuniendo los personajes de tus dispositivos…');
    }else{next=remote.state;shouldApply=true}
   }else if(remote.revision!==rev){
    const dirty=changedSinceBase(localState)||capturedFingerprint!==lastFingerprint;
    if(dirty){
     const edits=delta(base,localState);
     next=merge().merge(remote.state,edits,{base}).state;
    }else{next=remote.state;shouldApply=true}
   }else{
    if(!changedSinceBase(localState)&&capturedFingerprint===lastFingerprint){
     status('✓ Sincronizado · versión '+remote.revision);
     return;
    }
    next=localState;
   }
   // If nothing new needs publishing, just download/reconcile the cloud copy.
   if(same(next,remote.state)){
    if(shouldApply||!same(localState,next)){
     status('☁ Actualizando los personajes de este dispositivo…');
     const applied=await apply(next,remote.revision,capturedFingerprint);
     if(!applied){status('☁ Esperando un momento seguro para actualizar…');return}
    }
    await remember(remote.revision,next,values());
    status('✓ Sincronizado · versión '+remote.revision);
    return;
   }
   // The network may be slow; detect local edits that occurred during preparation.
   if(await fingerprint(values())!==capturedFingerprint){
    status('☁ Hay cambios nuevos; guardando la versión más reciente…');return;
   }
   let buffers=built?.buffers;
   // Metadata may change without files changing. For a conflict from another
   // device, hashes are already on the cloud; otherwise re-read local assets.
   const requiredHashes=new Set(Object.values(next.assets||{}).filter(info=>
    !Object.values(remote.state?.assets||{}).some(x=>x.hash===info.hash)).map(info=>info.hash));
   if(requiredHashes.size&&(!buffers||[...requiredHashes].some(h=>!buffers.has(h)))){
    const all=await manifestFromFiles(await localFiles());
    buffers=new Map([...(buffers||new Map()),...all.buffers]);
   }
   const committed=await publish(next,remote.revision,buffers,remote.state?.assets);
   if(bridge()?.isBusy()||await fingerprint(values())!==capturedFingerprint){
    await remember(committed.revision,next,capturedKV);
    if(!same(localState,next))set(PENDING,JSON.stringify({revision:committed.revision,fingerprint:capturedFingerprint}));
    status('✓ Guardado en Railway · versión '+committed.revision);
    return;
   }
   if(!same(localState,next)){
    const applied=await apply(next,committed.revision,capturedFingerprint);
    if(!applied){
     await remember(committed.revision,next,capturedKV);
     set(PENDING,JSON.stringify({revision:committed.revision,fingerprint:capturedFingerprint}));
     status('☁ Guardado; pendiente de actualizar la pantalla.');
     return;
    }
   }
   await remember(committed.revision,next,values());
   localStorage.removeItem(PENDING);
   status('✓ Sincronizado en la nube · versión '+committed.revision);
  }catch(e){
   loadError=true;
   notice('⚠ No se pudieron sincronizar los datos: '+e.message,true);
  }finally{working=false}
 }
 async function localBackup(){
  const assets=[];
  status('Preparando respaldo independiente…');
  try{
   for(const [key,blob] of await localFiles()){
    const bytes=new Uint8Array(await blob.arrayBuffer());let encoded='';
    for(let i=0;i<bytes.length;i+=8192)encoded+=String.fromCharCode(...bytes.subarray(i,i+8192));
    assets.push({key,type:blob.type,data:btoa(encoded)});
   }
   const data=JSON.stringify({schema:1,exportedAt:new Date().toISOString(),kv:values(),assets});
   const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));
   const link=document.createElement('a');link.href=url;link.download='persona-studio-respaldo.json';link.click();
   setTimeout(()=>URL.revokeObjectURL(url),60000);
   status('✓ Respaldo descargado.');
  }catch(e){notice('Error al crear respaldo: '+e.message,true)}
 }
 async function importBackup(file){
  if(!file||file.size>350000000||bridge()?.isBusy())return;
  if(!confirm('¿Importar este respaldo local? Se combinará con la nube sin eliminar los otros personajes.'))return;
  try{
   const data=JSON.parse(await file.text());
   if(data.schema!==1||!data.kv||!Array.isArray(data.assets))throw Error('Respaldo inválido');
   const files=new Map();
   for(const item of data.assets){
    if(typeof item.key!=='string'||item.key.length>220||typeof item.data!=='string'||
     item.data.length>((item.key==='music:background'||item.key.startsWith('music:track:'))?145000000:28000000))throw Error('Archivo inválido en el respaldo');
    const bin=atob(item.data),bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    files.set(item.key,new Blob([bytes],{type:item.type||'application/octet-stream'}));
   }
   const current=await localFiles();
   for(const [key,blob] of files)current.set(key,blob);
   await restoreFiles(current);
   for(const key of keys)if(typeof data.kv[key]==='string')set(key,data.kv[key]);
   localStorage.removeItem(LINK);localStorage.removeItem(BASE);localStorage.removeItem(REV);localStorage.removeItem(PENDING);
   base=null;lastRevision=0;
   set(DIRTY,'yes');
   await bridge().refresh();
   status('✓ Respaldo importado. Sincronizando automáticamente…');
   sync();
  }catch(e){notice('No se pudo importar el respaldo: '+e.message,true)}
 }
 async function init(){
  if(!bridge()||!merge()){status('La sincronización no pudo iniciarse.',true);return}
  const backup=$('cloudBackup'),restore=$('cloudRestoreBackup'),input=$('cloudBackupFile');
  if(backup)backup.onclick=localBackup;
  if(restore)restore.onclick=()=>input?.click();
  if(input)input.onchange=e=>{const f=e.target.files?.[0];if(f)importBackup(f);e.target.value=''};
  try{
   const response=await(await request('/api/cloud/status')).json();
   available=Boolean(response.available);
   if(!available){
    notice('⚠ No hay volumen permanente en Railway. Los datos siguen solamente en este dispositivo.',true);return;
   }
   const remembered=persistent(BASE);
   try{
    const parsed=JSON.parse(remembered||'null');
    if(parsed?.state&&Number.isInteger(parsed.revision)){base=parsed.state;lastRevision=parsed.revision}
   }catch{}
   lastFingerprint=persistent(FP)||'';
   initialized=true;
   status('☁ Conectando automáticamente con la nube…');
   await sync();
   // Reconcile after tab switching and while the app stays open.
   setInterval(sync,8000);
   document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule()});
   window.addEventListener('focus',schedule);
  }catch(e){notice('⚠ Sin conexión al guardado en Railway: '+e.message,true)}
 }
 window.PERSONA_CLOUD={markAssetsDirty,schedule};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,500),{once:true});
 else setTimeout(init,500);
})();