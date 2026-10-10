/* Música de fondo de Persona Studio. Archivo único, loop y ducking automático. */
(function(){
'use strict';
const KEY='music:background',GLOBAL='persona-studio-global-v3',MAX_BYTES=100*1024*1024;
const defaults={name:'',size:0,updatedAt:0,volume:18,duck:22};
const clamp=(n,min,max)=>Math.max(min,Math.min(max,Number.isFinite(Number(n))?Number(n):min));
function targetVolume(volume,duck,speaking){
 return clamp(volume,0,100)/100*(speaking?clamp(duck,0,100)/100:1);
}
function fadedVolume(current,target,ms,speaking){
 return clamp(current,0,1)+(clamp(target,0,1)-clamp(current,0,1))*(1-Math.exp(-clamp(ms,0,500)/(speaking?160:700)));
}
if(typeof module!=='undefined'&&module.exports)module.exports={targetVolume,fadedVolume,MAX_BYTES};
if(typeof document==='undefined')return;
const $=id=>document.getElementById(id);
const M={audio:null,url:null,stamp:'',active:false,settings:{...defaults},last:performance.now()};
function config(){try{const o=JSON.parse(localStorage.getItem(GLOBAL)||'{}');return {...defaults,...(o?.music&&typeof o.music==='object'?o.music:{})}}catch{return {...defaults}}}
function message(s,bad=false){const e=$('musicStatus');e.textContent=s;e.style.color=bad?'#ffc3a9':''}
function storeSettings(partial){
 try{const o=JSON.parse(localStorage.getItem(GLOBAL)||'{}')||{};o.music={...defaults,...(o.music||{}),...partial};localStorage.setItem(GLOBAL,JSON.stringify(o));M.settings=o.music;window.PERSONA_CLOUD?.schedule?.()}
 catch(e){message('Error guardando los ajustes: '+e.message,true)}
}
function paint(){
 const c=M.settings;
 $('musicInfo').textContent=c.name?c.name+' · '+Math.round(c.size/1024)+' KB':'Sin música cargada';
 $('musicPlay').disabled=!M.audio;$('musicRemove').disabled=!c.name;
 $('musicPlay').textContent=M.active?'⏸ Pausar música':'▶ Reproducir música';
 $('musicVolume').value=String(clamp(c.volume,0,100));$('musicVolumeValue').textContent=$('musicVolume').value+'%';
 $('musicDuck').value=String(clamp(c.duck,0,100));$('musicDuckValue').textContent=$('musicDuck').value+'%';
}
function release(){
 M.active=false;
 if(M.audio){M.audio.pause();M.audio.removeAttribute('src');M.audio.load()}
 if(M.url)URL.revokeObjectURL(M.url);
 M.audio=null;M.url=null;M.stamp='';
}
function db(){return new Promise((resolve,reject)=>{
 if(!window.indexedDB)return reject(Error('Almacenamiento de archivos no disponible.'));
 const r=indexedDB.open('persona-studio-sprites-v1',1);
 r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('sprites'))r.result.createObjectStore('sprites')};
 r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('No se pudo abrir la biblioteca de audio.'));
})}
async function readAudio(){
 const d=await db();try{return await new Promise((resolve,reject)=>{
  const req=d.transaction('sprites','readonly').objectStore('sprites').get(KEY);
  req.onsuccess=()=>resolve(req.result instanceof Blob?req.result:null);
  req.onerror=()=>reject(Error('No se pudo leer la música.'));
 })}finally{d.close()}
}
async function writeAudio(blob){
 const d=await db();try{await new Promise((resolve,reject)=>{
  const tx=d.transaction('sprites','readwrite'),s=tx.objectStore('sprites');
  if(blob)s.put(blob,KEY);else s.delete(KEY);
  tx.oncomplete=resolve;tx.onerror=()=>reject(Error('No se pudo guardar el audio.'));
  tx.onabort=()=>reject(Error('Se interrumpió el guardado.'));
 })}finally{d.close()}
}
async function refresh(){
 const cfg=config();M.settings=cfg;
 if(!cfg.name){release();paint();message('Cargá una pista para ponerla en loop.');return}
 let blob;try{blob=await readAudio()}catch(e){paint();message(e.message,true);return}
 if(!blob){release();paint();message('Esperando la pista de música desde Railway…');return}
 const stamp=String(cfg.updatedAt)+'|'+cfg.name+'|'+cfg.size;
 if(stamp===M.stamp&&M.audio){paint();return}
 const playing=M.active;release();
 const url=URL.createObjectURL(blob),audio=new Audio(url);
 audio.loop=true;audio.preload='auto';audio.volume=0;
 audio.onerror=()=>{M.active=false;paint();message('Formato no reproducible. Probá con MP3.',true)};
 M.audio=audio;M.url=url;M.stamp=stamp;paint();
 if(playing){try{await audio.play();M.active=true}catch{message('Pista actualizada. Tocá Reproducir para reanudar.')}}
 else message('Música lista. Tocá Reproducir para iniciar el loop.');
 paint();
}
async function choose(e){
 const file=e.target.files?.[0];e.target.value='';
 if(!file)return;
 if(!(/^audio\//i.test(file.type)||/\.(mp3|m4a|wav|ogg|webm|aac)$/i.test(file.name))){message('Elegí un audio, preferentemente MP3.',true);return}
 if(file.size<1||file.size>MAX_BYTES){message('El archivo no puede superar los 100 MB.',true);return}
 try{
  await writeAudio(file);
  storeSettings({name:file.name,size:file.size,updatedAt:Date.now()});
  window.PERSONA_CLOUD?.markAssetsDirty?.();
  await refresh();message('✓ Audio cargado y listo para sincronizarse con Railway.');
 }catch(e){message('No se pudo cargar el audio: '+e.message,true)}
}
async function toggle(){
 if(!M.audio)return;
 if(M.active){M.audio.pause();M.active=false;paint();message('Música en pausa.');return}
 try{M.audio.volume=0;await M.audio.play();M.active=true;M.last=performance.now();paint();message('♫ Loop activo · se atenúa cuando hablan los personajes o el moderador.')}
 catch(e){message('No se pudo iniciar el audio: '+e.message,true)}
}
async function remove(){
 if(!M.settings.name||!confirm('¿Eliminar esta pista de fondo?'))return;
 try{await writeAudio(null);storeSettings({name:'',size:0,updatedAt:Date.now()});window.PERSONA_CLOUD?.markAssetsDirty?.();release();paint();message('Música eliminada. La nube se actualizará automáticamente.')}
 catch(e){message('No se pudo eliminar la pista: '+e.message,true)}
}
function tick(){
 const now=performance.now(),elapsed=Math.max(0,Math.min(250,now-M.last));M.last=now;
 if(M.audio&&M.active){
  const speaking=Boolean(window.PERSONA_MUSIC_BRIDGE?.isSpeaking?.());
  M.audio.volume=fadedVolume(M.audio.volume,targetVolume(M.settings.volume,M.settings.duck,speaking),elapsed,speaking);
 }
}
function init(){
 $('musicFile').addEventListener('change',choose);
 $('musicPlay').addEventListener('click',toggle);
 $('musicRemove').addEventListener('click',remove);
 for(const [id,key] of [['musicVolume','volume'],['musicDuck','duck']])$(id).addEventListener('input',e=>{storeSettings({[key]:clamp(e.target.value,0,100)});paint()});
 window.PERSONA_MUSIC={refresh};
 refresh();setInterval(tick,50);window.addEventListener('pagehide',release);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
