/* Persona Studio — sincronización privada con volumen persistente.
   Nunca sube ni reemplaza datos iniciales sin que el propietario elija la versión. */
(()=>{
 'use strict';
 const keys=['persona-studio-profiles-v3','persona-studio-profile-index-v3','persona-studio-duels-v1',
  'persona-studio-backgrounds-v1','persona-studio-global-v3','persona-studio-stage-share-v1'];
 const LINK='persona-studio-cloud-linked-v1',REV='persona-studio-cloud-revision-v1',
       FP='persona-studio-cloud-fingerprint-v1',DIRTY='persona-studio-cloud-assets-dirty-v1';
 const $=id=>document.getElementById(id);
 const b=()=>window.PERSONA_CLOUD_BRIDGE;
 const dbName='persona-studio-sprites-v1';
 let available=false,linked=localStorage.getItem(LINK)==='yes',busy=false,conflict=false,lastRemote=null;
 let lastKV='';let lastRev=Number(localStorage.getItem(REV)||0);
 let lastFingerprint=localStorage.getItem(FP)||'';
 function status(text,error=false){const node=$('cloudStatus');if(node){node.textContent=text;node.style.color=error?'#ffc3a9':''}}
 function kv(){const data={};for(const key of keys){const value=localStorage.getItem(key);if(value!==null)data[key]=value}return data}
 function serialized(obj){return JSON.stringify(obj)}
 async function digest(buffer){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(x=>x.toString(16).padStart(2,'0')).join('')}
 async function fingerprint(data){return digest(new TextEncoder().encode(serialized(data)))}
 async function call(url,opts={}){
  const response=await fetch(url,{credentials:'same-origin',cache:'no-store',...opts});
  if(!response.ok){const detail=await response.json().catch(()=>({}));const err=Error(detail.error||'Error de nube ('+response.status+')');err.status=response.status;throw err}
  return response;
 }
 async function getRemote(){return (await call('/api/cloud/state')).json()}
 function readDB(){return new Promise((resolve,reject)=>{
  const req=indexedDB.open(dbName,1);
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('sprites'))req.result.createObjectStore('sprites')};
  req.onsuccess=()=>resolve(req.result);
  req.onerror=()=>reject(Error('No se pudo abrir IndexedDB'));
 })}
 async function scanAssets(){
  const db=await readDB();
  try{return await new Promise((resolve,reject)=>{
   const values=[];const tx=db.transaction('sprites','readonly');
   const cursor=tx.objectStore('sprites').openCursor();
   cursor.onsuccess=()=>{
    const p=cursor.result;if(!p)return;
    if(typeof p.key==='string'&&p.value instanceof Blob)values.push({key:p.key,blob:p.value});
    p.continue();
   };
   cursor.onerror=()=>reject(Error('No se pudieron leer las imágenes y voces.'));
   tx.oncomplete=()=>resolve(values);
   tx.onerror=()=>reject(Error('No se pudieron recuperar los archivos locales.'));
  })}finally{db.close()}
 }
 async function writeAssets(files){
  const db=await readDB();
  try{
   await new Promise((resolve,reject)=>{
    const tx=db.transaction('sprites','readwrite'),store=tx.objectStore('sprites');
    store.clear();
    for(const {key,blob} of files)store.put(blob,key);
    tx.oncomplete=resolve;tx.onerror=()=>reject(Error('No se pudo restaurar un archivo local.'));
   });
  }finally{db.close()}
 }
 function markAssetsDirty(){localStorage.setItem(DIRTY,'yes')}
 async function buildManifest(previous={}){
  const result={};
  const assets=await scanAssets();
  let count=0;
  for(const {key,blob} of assets){
   if(blob.size>20000000)throw Error('El archivo '+key+' supera los 20 MB.');
   const buffer=await blob.arrayBuffer(),hash=await digest(buffer);
   result[key]={hash,type:blob.type||'application/octet-stream',size:blob.size};
   if(previous[key]?.hash!==hash){
    await call('/api/cloud/assets/'+hash,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:buffer});
   }
   count++;
   if(count%5===0)status('Guardando imágenes y voces: '+count+' de '+assets.length+'…');
  }
  return result;
 }
 function saveLinked(revision,data){
  linked=true;lastRev=revision;lastKV=serialized(data);
  localStorage.setItem(LINK,'yes');localStorage.setItem(REV,String(revision));
  localStorage.removeItem(DIRTY);
 }
 async function finishLinked(revision,data){
  saveLinked(revision,data);
  lastFingerprint=await fingerprint(data);
  localStorage.setItem(FP,lastFingerprint);
  conflict=false;
 }
 function showError(e){status('Nube: '+e.message,true)}
 async function upload(force=false){
  if(!available||busy)return;
  if(b()?.isBusy())return status('Esperá a que termine la intervención antes de guardar.');
  busy=true;
  try{
   status('Preparando copia segura en la nube…');
   const remote=await getRemote();lastRemote=remote;
   if(!force&&linked&&remote.revision!==lastRev){
    conflict=true;return status('La nube cambió en otro dispositivo. Elegí Guardar o Recuperar para resolverlo.',true);
   }
   const data=kv();
   const assetsNeedUpload=force||localStorage.getItem(DIRTY)==='yes'||!remote.state;
   const assets=assetsNeedUpload?await buildManifest(remote.state?.assets||{}):remote.state.assets;
   const snapshot={schema:1,kv:data,assets};
   const saved=(await call('/api/cloud/state',{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({baseRevision:remote.revision,state:snapshot})})).json();
   const response=await saved;
   lastRemote={revision:response.revision,state:snapshot,updatedAt:response.updatedAt};
   await finishLinked(response.revision,data);
   status('✓ Guardado en la nube · versión '+response.revision);
  }catch(e){if(e.status===409)conflict=true;showError(e)}
  finally{busy=false}
 }
 async function pull(force=false){
  if(!available||busy)return;
  if(b()?.isBusy())return status('Esperá a que termine el debate para recuperar la copia.');
  busy=true;
  try{
   status('Descargando personajes, voces y fondos…');
   const remote=await getRemote();
   if(!remote.state)return status('Todavía no hay una copia en la nube.');
   const manifest=remote.state.assets||{},files=[];
   let n=0;
   for(const [key,info] of Object.entries(manifest)){
    const blob=await (await call('/api/cloud/assets/'+info.hash)).blob();
    files.push({key,blob:new Blob([blob],{type:info.type||'application/octet-stream'})});
    n++;if(n%5===0)status('Recuperando archivos: '+n+' de '+Object.keys(manifest).length+'…');
   }
   // Restaurar primero los archivos; después la metadata. Si falla la descarga, no se toca nada.
   await writeAssets(files);
   for(const key of keys){
    if(Object.prototype.hasOwnProperty.call(remote.state.kv,key))localStorage.setItem(key,remote.state.kv[key]);
    else localStorage.removeItem(key);
   }
   await finishLinked(remote.revision,remote.state.kv);
   lastRemote=remote;
   await b().refresh();
   status('✓ Recuperado desde la nube · versión '+remote.revision);
  }catch(e){showError(e)}finally{busy=false}
 }
 async function downloadBackup(){
  if(busy)return;
  busy=true;try{
   status('Preparando respaldo local…');
   const assets=[];
   for(const {key,blob} of await scanAssets()){
    const raw=await blob.arrayBuffer(),bytes=new Uint8Array(raw);
    // Generar base64 por fragmentos para evitar límites del stack.
    let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    assets.push({key,type:blob.type,data:btoa(binary)});
   }
   const doc=JSON.stringify({schema:1,exportedAt:new Date().toISOString(),kv:kv(),assets});
   const url=URL.createObjectURL(new Blob([doc],{type:'application/json'}));
   const a=document.createElement('a');a.href=url;a.download='persona-studio-respaldo-local.json';
   a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
   status('Respaldo local descargado.');
  }catch(e){showError(e)}finally{busy=false}
 }
 async function restoreLocalBackup(file){
  if(busy||b()?.isBusy())return status('Detené el debate antes de importar un respaldo.',true);
  if(!file||file.size>350000000)return status('Archivo de respaldo inválido o demasiado grande.',true);
  if(!confirm('¿Importar este respaldo? Reemplazará los personajes, voces, fondos y debates LOCALES de este dispositivo.'))return;
  busy=true;
  try{
   status('Leyendo el respaldo local…');
   const backup=JSON.parse(await file.text());
   if(backup?.schema!==1||!backup.kv||!Array.isArray(backup.assets)||
      Object.keys(backup.kv).some(k=>!keys.includes(k))||backup.assets.length>750)
    throw Error('Formato de respaldo inválido.');
   const files=[];
   for(const item of backup.assets){
    if(typeof item.key!=='string'||item.key.length>220||typeof item.data!=='string'||
       typeof item.type!=='string')throw Error('Archivo de respaldo inválido.');
    const binary=atob(item.data);
    if(binary.length>20000000)throw Error('Una imagen o voz supera el límite de 20 MB.');
    const bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    files.push({key:item.key,blob:new Blob([bytes],{type:item.type})});
   }
   await writeAssets(files);
   for(const key of keys){
    if(typeof backup.kv[key]==='string')localStorage.setItem(key,backup.kv[key]);
    else localStorage.removeItem(key);
   }
   markAssetsDirty();
   conflict=linked; // Nunca subir una importación accidentalmente si hay otra copia remota.
   await b().refresh();
   status('✓ Respaldo importado. Si querés compartirlo, tocá Guardar este dispositivo.');
  }catch(e){showError(e)}
  finally{busy=false}
 }
 function hasLocalWork(){
  try{
   const profiles=JSON.parse(localStorage.getItem(keys[1])||'[]');
   const data=JSON.parse(localStorage.getItem(keys[0])||'{}');
   const topics=JSON.parse(localStorage.getItem(keys[2])||'{}');
   return profiles.length>1||Object.keys(data).length>1||Object.values(data).some(v=>v?.settings?.persona&&v.settings.persona.length>100)
     ||topics.topics?.some(t=>t.messages?.length||t.left||t.right||t.theme);
  }catch{return true}
 }
 async function tick(){
  if(!available||busy||!linked||conflict||b()?.isBusy())return;
  try{
   const remote=await getRemote();lastRemote=remote;
   const now=kv(),fp=await fingerprint(now);
   const dirty=fp!==lastFingerprint||localStorage.getItem(DIRTY)==='yes';
   if(remote.revision!==lastRev){
    if(dirty){
     conflict=true;status('Cambios distintos en dos dispositivos. Elegí Guardar o Recuperar.',true);
    }else await pull();
   }else if(dirty)await upload();
  }catch(e){showError(e)}
 }
 async function init(){
  if(new URLSearchParams(location.search).get('output')==='1')return;
  if(!b()){status('No se pudo iniciar la sincronización.',true);return}
  $('cloudPush').onclick=()=>{
   if(b().isBusy())return status('Detené el debate antes de migrar.');
   if(!confirm('¿Guardar los personajes, fondos, voces y debates DE ESTE dispositivo en la nube? Si existe otra copia, la reemplazará.'))return;
   conflict=false;upload(true);
  };
  $('cloudPull').onclick=()=>{
   if(b().isBusy())return status('Detené el debate antes de recuperar.');
   if(!confirm('¿Recuperar desde la nube? Se reemplazarán los personajes, voces, fondos e historiales locales de ESTE dispositivo. Hacé primero un respaldo local si querés conservarlos.'))return;
   conflict=false;pull(true);
  };
  $('cloudBackup').onclick=downloadBackup;
 $('cloudRestoreBackup').onclick=()=>$('cloudBackupFile').click();
 $('cloudBackupFile').onchange=e=>{
  const file=e.target.files?.[0];if(file)restoreLocalBackup(file);
  e.target.value='';
 };
  try{
   const cloudStatus=(await call('/api/cloud/status')).json();
   const cloud=await cloudStatus;available=Boolean(cloud.available);
   if(!available){status('⚠ Falta configurar el volumen persistente de Railway. Los datos todavía son locales.');return}
   const remote=await getRemote();lastRemote=remote;
   status(remote.state?'Copia existente en la nube. Elegí Recuperar o Guardar este dispositivo.':'Nube lista. Elegí Guardar este dispositivo para la primera copia.');
   if(linked&&remote.state){
    const fp=await fingerprint(kv());
    const dirty=fp!==lastFingerprint||localStorage.getItem(DIRTY)==='yes';
    if(remote.revision!==lastRev){
     if(dirty){conflict=true;status('Hay cambios locales y en la nube. Elegí cuál conservar.',true)}
     else await pull();
    }else if(dirty)await upload();
    else status('✓ Sincronizado con la nube · versión '+lastRev);
   }else if(linked&&!remote.state){
    linked=false;localStorage.removeItem(LINK);
    status('La copia de nube no existe. Guardá este dispositivo para crearla.',true);
   }else if(!remote.state&&!hasLocalWork()){
    status('Nube preparada. Guardá este dispositivo cuando termines de configurar tus personajes.');
   }
  }catch(e){showError(e)}
  setInterval(tick,12000);
 }
 window.PERSONA_CLOUD={markAssetsDirty};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
