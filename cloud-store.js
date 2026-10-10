'use strict';
// Persistencia de Persona Studio sobre un VOLUMEN montado por Railway.
// No escribe en el filesystem efímero de cada deploy.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const KEYS=new Set([
 'persona-studio-profiles-v3',
 'persona-studio-profile-index-v3',
 'persona-studio-duels-v1',
 'persona-studio-backgrounds-v1',
 'persona-studio-global-v3',
 'persona-studio-stage-share-v1',
]);
// Railway permite montar un volumen en /data sin otra configuración.
const dir=path.resolve(process.env.PERSISTENT_DATA_DIR||'/data');
function isMountedDirectory(folder){
 if(!folder||folder==='/'||folder.startsWith('/tmp/')||folder==='/tmp')return false;
 if(process.env.NODE_ENV!=='production'&&process.env.CLOUD_ALLOW_DEV_DISK==='1')return true;
 try{
  const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').map(l=>l.split(' ')[4]).filter(Boolean).map(v=>v.replace(/\\040/g,' '));
  return mounts.some(m=>m!=='/'&&(folder===m||folder.startsWith(m+'/')));
 }catch{return false}
}
let root=null,error='Falta montar un volumen persistente en Railway (ruta /data).';
try{
 if(dir&&fs.existsSync(dir)&&fs.statSync(dir).isDirectory()&&isMountedDirectory(dir)){
  root=path.join(dir,'persona-studio-cloud-v1');
  fs.mkdirSync(path.join(root,'assets'),{recursive:true});
  fs.accessSync(root,fs.constants.R_OK|fs.constants.W_OK);
 }else error='No se detectó un volumen persistente en '+dir+'. Los datos seguirán locales hasta montarlo.';
}catch(e){root=null;error='No se puede acceder al volumen persistente: '+e.message}
function available(){return Boolean(root)}
function status(){return {available:available(),reason:root?null:error}}
function requireStorage(){if(!root)throw Object.assign(Error(error),{status:503})}
function stateFile(){return path.join(root,'state.json')}
function readState(){
 requireStorage();
 try{
  const obj=JSON.parse(fs.readFileSync(stateFile(),'utf8'));
  if(!Number.isSafeInteger(obj.revision)||obj.revision<0||!obj.state)throw Error('Estado persistente inválido');
  return obj;
 }catch(e){
  if(e.code==='ENOENT')return {revision:0,state:null,updatedAt:null};
  throw Object.assign(Error('No se pudo leer la copia persistente: '+e.message),{status:500});
 }
}
function validateState(st){
 if(!st||st.schema!==1||!st.kv||typeof st.kv!=='object'||Array.isArray(st.kv)||
    !st.assets||typeof st.assets!=='object'||Array.isArray(st.assets))throw Object.assign(Error('Esquema de copia inválido'),{status:400});
 if(Object.keys(st.kv).some(k=>!KEYS.has(k)))throw Object.assign(Error('Clave local no permitida'),{status:400});
 for(const v of Object.values(st.kv))if(typeof v!=='string'||v.length>2000000)throw Object.assign(Error('Configuración demasiado grande'),{status:413});
 if(Object.keys(st.assets).length>750)throw Object.assign(Error('Demasiados archivos'),{status:413});
 for(const [k,v] of Object.entries(st.assets)){
  if(k.length>220||!v||typeof v!=='object'||!/^([a-f0-9]{64})$/.test(v.hash)||
     !Number.isInteger(v.size)||v.size<0||v.size>20000000||
     typeof v.type!=='string'||v.type.length>100)throw Object.assign(Error('Manifiesto de archivo inválido'),{status:400});
  if(!fs.existsSync(assetPath(v.hash)))throw Object.assign(Error('Falta subir un archivo antes del manifiesto'),{status:409});
 }
}
function assetPath(hash){return path.join(root,'assets',hash)}
function updateState(body){
 requireStorage();
 if(!Number.isSafeInteger(body?.baseRevision)||body.baseRevision<0)throw Object.assign(Error('Versión de copia inválida'),{status:400});
 const current=readState();
 if(current.revision!==body.baseRevision)throw Object.assign(Error('La nube cambió en otro dispositivo. Elegí qué versión conservar.'),{status:409,currentRevision:current.revision});
 validateState(body.state);
 const next={revision:current.revision+1,state:body.state,updatedAt:new Date().toISOString()};
 const tmp=stateFile()+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
 try{
  fs.writeFileSync(tmp,JSON.stringify(next),{mode:0o600});
  fs.renameSync(tmp,stateFile());
 }finally{try{fs.unlinkSync(tmp)}catch{}}
 return {revision:next.revision,updatedAt:next.updatedAt};
}
function putAsset(hash,buffer){
 requireStorage();
 if(!/^[a-f0-9]{64}$/.test(hash))throw Object.assign(Error('Identificador de archivo inválido'),{status:400});
 if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>20000000)throw Object.assign(Error('Archivo inválido o demasiado grande'),{status:413});
 if(crypto.createHash('sha256').update(buffer).digest('hex')!==hash)throw Object.assign(Error('El archivo no coincide con su firma'),{status:400});
 const dest=assetPath(hash);
 if(!fs.existsSync(dest)){
  const tmp=dest+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  try{fs.writeFileSync(tmp,buffer,{flag:'wx',mode:0o600});fs.renameSync(tmp,dest)}
  finally{try{fs.unlinkSync(tmp)}catch{}}
 }
 return {hash,size:buffer.length};
}
function getAsset(hash){
 requireStorage();
 if(!/^[a-f0-9]{64}$/.test(hash))throw Object.assign(Error('Archivo inválido'),{status:400});
 try{return fs.readFileSync(assetPath(hash))}
 catch(e){if(e.code==='ENOENT')throw Object.assign(Error('Archivo no encontrado'),{status:404});throw e}
}
module.exports={status,readState,updateState,putAsset,getAsset};
