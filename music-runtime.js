/* Persona Studio: biblioteca de música de fondo con loop y ducking.
   Los archivos viven en IndexedDB y los sincroniza cloud-sync.js a Railway. */
(function(){
 'use strict';
 const GLOBAL='persona-studio-global-v3',LEGACY='music:background',PREFIX='music:track:',MAX_BYTES=100*1024*1024;
 const clamp=(n,min,max)=>Math.max(min,Math.min(max,Number.isFinite(Number(n))?Number(n):min));
 const assetKey=id=>id==='legacy'?LEGACY:PREFIX+id;
 const cleanName=name=>String(name||'').replace(/\.[a-z0-9]{2,5}$/i,'').trim().slice(0,70)||'Música sin nombre';
 const activeTracks=m=>m.tracks.filter(t=>!t.deletedAt).sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
 function normalizeMusic(raw){
  const old=raw&&typeof raw==='object'?raw:{};
  const legacy=!Array.isArray(old.tracks)&&old.name?
   [{id:'legacy',name:cleanName(old.name),fileName:String(old.name),size:Number(old.size)||0,addedAt:Number(old.updatedAt)||1,updatedAt:Number(old.updatedAt)||1}]:[];
  const tracks=Array.isArray(old.tracks)?old.tracks:legacy;
  const ids=new Set();
  const cleaned=tracks.filter(t=>{
   if(!t||typeof t.id!=='string'||(!/^([a-z0-9_-]{1,80})$/i.test(t.id))||ids.has(t.id))return false;
   ids.add(t.id);return true;
  }).map(t=>({id:t.id,name:cleanName(t.name||t.fileName),fileName:String(t.fileName||t.name||'').slice(0,160),
   size:Math.max(0,Number(t.size)||0),addedAt:Number(t.addedAt)||0,updatedAt:Number(t.updatedAt)||0,
   ...(t.deletedAt?{deletedAt:Number(t.deletedAt)}:{})}));
  const selected=String(old.selectedId||'');
  const live=activeTracks({tracks:cleaned});
  return {tracks:cleaned,selectedId:live.some(t=>t.id===selected)?selected:(live[0]?.id||''),
    volume:clamp(old.volume??18,0,100),duck:clamp(old.duck??22,0,100),
    settingsUpdatedAt:Number(old.settingsUpdatedAt||old.updatedAt)||0};
 }
 function targetVolume(volume,duck,speaking){
  return clamp(volume,0,100)/100*(speaking?clamp(duck,0,100)/100:1);
 }
 function fadedVolume(current,target,ms,speaking){
  return clamp(current,0,1)+(clamp(target,0,1)-clamp(current,0,1))*(1-Math.exp(-clamp(ms,0,500)/(speaking?160:700)));
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={normalizeMusic,targetVolume,fadedVolume,assetKey,MAX_BYTES};
 if(typeof document==='undefined')return;
 const $=id=>document.getElementById(id);
 const M={audio:null,url:null,loadedId:'',loadedStamp:'',music:normalizeMusic({}),active:false,last:performance.now(),refreshToken:0,busy:false};
 function load(){
  try{return normalizeMusic(JSON.parse(localStorage.getItem(GLOBAL)||'{}')?.music)}
  catch{return normalizeMusic({})}
 }
 function save(m){
  try{
   const global=JSON.parse(localStorage.getItem(GLOBAL)||'{}')||{};
   global.music=normalizeMusic(m);
   localStorage.setItem(GLOBAL,JSON.stringify(global));
   M.music=global.music;
   window.PERSONA_CLOUD?.schedule?.();
   return true;
  }catch(e){status('No se pudieron guardar los cambios: '+e.message,true);return false}
 }
 function status(text,error=false){
  const el=$('musicStatus');if(!el)return;
  el.textContent=text;el.style.color=error?'#ffc3a9':'';
 }
 function selected(){return M.music.tracks.find(t=>t.id===M.music.selectedId&&!t.deletedAt)||null}
 function release(){
  M.active=false;
  if(M.audio){M.audio.pause();M.audio.removeAttribute('src');M.audio.load()}
  if(M.url)URL.revokeObjectURL(M.url);
  M.audio=null;M.url=null;M.loadedId='';M.loadedStamp='';
 }
 function format(seconds){
  if(!Number.isFinite(seconds)||seconds<0)return '0:00';
  const s=Math.floor(seconds);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
 }
 function paintLibrary(){
  const list=activeTracks(M.music),select=$('musicSelect'),wanted=M.music.selectedId;
  select.replaceChildren();
  if(!list.length){const opt=document.createElement('option');opt.textContent='Sin canciones';opt.value='';select.append(opt)}
  for(const t of list){
   const opt=document.createElement('option');opt.value=t.id;opt.textContent=t.name;select.append(opt);
  }
  select.value=wanted||'';
  select.disabled=!list.length||M.busy;
  $('musicRename').disabled=!selected()||M.busy;
  $('musicRemove').disabled=!selected()||M.busy;
  $('musicAdd').disabled=M.busy;
  $('musicCount').textContent=list.length===1?'1 canción':list.length+' canciones';
  $('musicVolume').value=String(M.music.volume);
  $('musicVolumeValue').textContent=M.music.volume+'%';
  $('musicDuck').value=String(M.music.duck);
  $('musicDuckValue').textContent=M.music.duck+'%';
  paintPlayback();
 }
 function paintPlayback(){
  $('musicPlay').disabled=!M.audio||M.busy;
  $('musicPlay').textContent=M.active?'⏸':'▶';
  $('musicPlay').setAttribute('aria-label',M.active?'Pausar música':'Reproducir música');
  $('musicPlay').title=M.active?'Pausar':'Reproducir';
  const duration=M.audio?.duration,valid=Number.isFinite(duration)&&duration>0;
  $('musicSeek').disabled=!valid||M.busy;
  if(valid){
   $('musicSeek').value=String(Math.round(clamp(M.audio.currentTime/duration,0,1)*1000));
   $('musicClock').textContent=format(M.audio.currentTime)+' / '+format(duration);
  }else{
   $('musicSeek').value='0';$('musicClock').textContent='0:00 / 0:00';
  }
 }
 function openDB(){return new Promise((resolve,reject)=>{
  if(!window.indexedDB)return reject(Error('El navegador no admite guardar archivos.'));
  const q=indexedDB.open('persona-studio-sprites-v1',1);
  q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains('sprites'))q.result.createObjectStore('sprites')};
  q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(Error('No se pudo abrir la biblioteca de audio.'));
 })}
 async function getBlob(key){
  const d=await openDB();
  try{return await new Promise((resolve,reject)=>{
   const tx=d.transaction('sprites','readonly'),r=tx.objectStore('sprites').get(key);
   r.onsuccess=()=>resolve(r.result instanceof Blob?r.result:null);
   r.onerror=()=>reject(Error('No se pudo leer la canción.'));
  })}finally{d.close()}
 }
 async function putBlob(key,blob){
  const d=await openDB();
  try{await new Promise((resolve,reject)=>{
   const tx=d.transaction('sprites','readwrite'),store=tx.objectStore('sprites');
   if(blob)store.put(blob,key);else store.delete(key);
   tx.oncomplete=resolve;tx.onerror=()=>reject(Error('No se pudo guardar la canción.'));
   tx.onabort=()=>reject(Error('Se interrumpió el guardado.'));
  })}finally{d.close()}
 }
 async function refresh(){
  const token=++M.refreshToken,m=load(),newTrack=m.tracks.find(t=>t.id===m.selectedId&&!t.deletedAt)||null;
  M.music=m;
  if(!newTrack){
   release();paintLibrary();status('Agregá una canción para comenzar.');return;
  }
  const stamp=newTrack.id+':'+newTrack.size+':'+(newTrack.addedAt||0);
  if(M.audio&&M.loadedId===newTrack.id&&M.loadedStamp===stamp){
   paintLibrary();return;
  }
  const wasPlaying=M.active;
  let blob;
  try{blob=await getBlob(assetKey(newTrack.id))}
  catch(e){if(token===M.refreshToken){paintLibrary();status(e.message,true)}return}
  if(token!==M.refreshToken)return;
  if(!blob){
   release();paintLibrary();status('Esta canción todavía se está descargando de la nube…');return;
  }
  release();
  const url=URL.createObjectURL(blob),audio=new Audio(url);
  audio.loop=true;audio.preload='metadata';audio.volume=0;
  audio.onloadedmetadata=paintPlayback;
  audio.ontimeupdate=paintPlayback;
  audio.onended=()=>{M.active=false;paintPlayback()};
  audio.onerror=()=>{M.active=false;paintPlayback();status('No se pudo reproducir este formato. Probá MP3.',true)};
  M.audio=audio;M.url=url;M.loadedId=newTrack.id;M.loadedStamp=stamp;paintLibrary();
  if(wasPlaying){
   try{await audio.play();if(token===M.refreshToken){M.active=true;paintPlayback()}}
   catch{status('Pista elegida. Tocá ▶ para empezar.')}
  }else status('Pista lista · se repite automáticamente.');
 }
 async function chooseFiles(e){
  const files=[...(e.target.files||[])];e.target.value='';
  if(!files.length)return;
  M.busy=true;paintLibrary();let count=0,errors=[];
  for(const file of files){
   if(!(/^audio\//i.test(file.type)||/\.(mp3|m4a|wav|ogg|webm|aac)$/i.test(file.name))){
    errors.push(file.name+': formato no admitido');continue;
   }
   if(file.size<1||file.size>MAX_BYTES){errors.push(file.name+': supera 100 MB');continue}
   const now=Date.now(),id='t_'+(typeof crypto?.randomUUID==='function'?crypto.randomUUID().replace(/-/g,''):now.toString(36)+Math.random().toString(36).slice(2));
   try{
    await putBlob(assetKey(id),file);
    const m=load();
    m.tracks.push({id,name:cleanName(file.name),fileName:file.name.slice(0,160),size:file.size,addedAt:now,updatedAt:now});
    m.selectedId=id;m.settingsUpdatedAt=now;
    if(!save(m))throw Error('No se pudo guardar el nombre');
    count++;
   }catch(err){errors.push(file.name+': '+err.message)}
  }
  M.busy=false;
  if(count)window.PERSONA_CLOUD?.markAssetsDirty?.();
  await refresh();
  status((count?'✓ '+count+(count===1?' canción guardada.':' canciones guardadas.')+' Se sincronizan con Railway.':'No se pudo cargar música.')+
    (errors.length?' '+errors.join('; '):''),!!errors.length);
 }
 async function selectTrack(e){
  const id=e.target.value,m=load();
  if(!m.tracks.some(t=>t.id===id&&!t.deletedAt))return;
  m.selectedId=id;m.settingsUpdatedAt=Date.now();save(m);
  await refresh();
 }
 async function toggle(){
  if(!M.audio)return;
  if(M.active){
   M.audio.pause();M.active=false;paintPlayback();status('Música en pausa.');return;
  }
  try{
   M.last=performance.now();M.audio.volume=0;
   await M.audio.play();
   M.active=true;paintPlayback();status('♫ Reproduciendo en loop. Se atenúa cuando hablan.');
  }catch(e){status('No se pudo reproducir: '+e.message,true)}
 }
 function rename(){
  const item=selected();if(!item)return;
  const name=prompt('Nombre de la canción:',item.name);
  if(name===null)return;
  if(!name.trim()){status('El nombre no puede estar vacío.',true);return}
  const m=load(),track=m.tracks.find(t=>t.id===item.id&&!t.deletedAt);
  if(!track)return;
  track.name=name.trim().slice(0,70);track.updatedAt=Date.now();
  if(save(m)){paintLibrary();status('Nombre actualizado y listo para sincronizarse.')}
 }
 async function remove(){
  const current=selected();if(!current)return;
  if(!confirm('¿Eliminar "'+current.name+'" de la biblioteca y de la nube?'))return;
  M.busy=true;paintLibrary();
  try{
   await putBlob(assetKey(current.id),null);
   const m=load(),track=m.tracks.find(t=>t.id===current.id);
   if(track){const now=Date.now();track.deletedAt=now;track.updatedAt=now}
   const remaining=activeTracks(m);
   if(m.selectedId===current.id){m.selectedId=remaining[0]?.id||'';m.settingsUpdatedAt=Date.now()}
   save(m);window.PERSONA_CLOUD?.markAssetsDirty?.();
   M.busy=false;await refresh();status('Canción eliminada; la nube se actualizará.');
  }catch(e){M.busy=false;paintLibrary();status('No se pudo eliminar: '+e.message,true)}
 }
 function seek(e){
  const a=M.audio;
  if(!a||!Number.isFinite(a.duration)||a.duration<=0)return;
  a.currentTime=clamp(Number(e.target.value)/1000,0,1)*a.duration;
  paintPlayback();
 }
 function tick(){
  const now=performance.now(),ms=Math.min(250,Math.max(0,now-M.last));M.last=now;
  if(M.audio&&M.active){
   const speaking=Boolean(window.PERSONA_MUSIC_BRIDGE?.isSpeaking?.());
   M.audio.volume=fadedVolume(M.audio.volume,targetVolume(M.music.volume,M.music.duck,speaking),ms,speaking);
  }
 }
 function init(){
  $('musicAdd').onclick=()=>$('musicFile').click();
  $('musicFile').addEventListener('change',chooseFiles);
  $('musicSelect').addEventListener('change',selectTrack);
  $('musicPlay').addEventListener('click',toggle);
  $('musicRename').addEventListener('click',rename);
  $('musicRemove').addEventListener('click',remove);
  $('musicSeek').addEventListener('input',seek);
  for(const [id,key] of [['musicVolume','volume'],['musicDuck','duck']]){
   $(id).addEventListener('input',e=>{
    const m=load();m[key]=clamp(e.target.value,0,100);m.settingsUpdatedAt=Date.now();
    if(save(m))paintLibrary();
   });
  }
  window.PERSONA_MUSIC={refresh};
  refresh();setInterval(tick,50);window.addEventListener('pagehide',release);
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
 else init();
})();
