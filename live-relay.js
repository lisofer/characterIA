'use strict';
/* Solo lectura: el público ve el escenario mediante un enlace privado de LIVE Studio.
   No hay acceso a voces, transcripciones privadas, claves ni controles del moderador. */
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const cloud=require('./cloud-store');
function setupLiveRelay(secret){
 const key=crypto.createHmac('sha256',secret).update('persona-studio-live-link-v1').digest('hex');
 let scene=null,updatedAt=0,lastAcceptedAt=0;
 const page=fs.readFileSync(path.join(__dirname,'live-view.html'));
 function valid(token){return typeof token==='string'&&token.length===64&&
  crypto.timingSafeEqual(Buffer.from(token),Buffer.from(key))}
 function accept(next){
  if(!next||typeof next!=='object'||!next.topic||typeof next.topic!=='object')throw Object.assign(Error('Escena inválida'),{status:400});
  const t=next.topic;
  for(const field of ['id','title','left','right','leftBackgroundId','rightBackgroundId','stageBackgroundId']){
   if(t[field]!==undefined&&(typeof t[field]!=='string'||t[field].length>250))
    throw Object.assign(Error('Campo inválido: '+field),{status:400});
  }
  if(!next.names||typeof next.names.left!=='string'||typeof next.names.right!=='string'||
     next.names.left.length>100||next.names.right.length>100)
    throw Object.assign(Error('Participantes inválidos'),{status:400});
  if(next.episode!==undefined&&(typeof next.episode!=='string'||next.episode.length>160))
    throw Object.assign(Error('Título inválido'),{status:400});
  const speech=next.speech;
  if(speech!==null&&speech!==undefined){
   if(!['left','right','moderator'].includes(speech.side)||typeof speech.elapsed!=='number'||
    !Number.isFinite(speech.elapsed)||!speech.plan||!Array.isArray(speech.plan.words)||
    !Array.isArray(speech.plan.offsets)||!Array.isArray(speech.plan.lengths)||
    !Array.isArray(speech.plan.sentences)||speech.plan.words.length>120||
    speech.plan.sentences.length>45)throw Object.assign(Error('Audio/gestos inválidos'),{status:400});
  }
  if(Date.now()-lastAcceptedAt<110)return {ok:true};
  // Only allow the shapes needed to draw the stage; never store history/prompts.
  scene={topic:{id:t.id||'',title:t.title||'',left:t.left||'',right:t.right||'',
    leftBackgroundId:t.leftBackgroundId||'',rightBackgroundId:t.rightBackgroundId||'',
    stageBackgroundId:t.stageBackgroundId||''},
   names:{left:next.names.left,right:next.names.right},
   episode:next.episode||'',scales:{left:Number(next.scales?.left)||1.1,right:Number(next.scales?.right)||1.1},
   speech:speech?{side:speech.side,elapsed:speech.elapsed,plan:speech.plan,
    delay:Number(speech.delay)||0,intensity:Number(speech.intensity)||45,ready:!!speech.ready,
    sampledAt:Number.isFinite(speech.sampledAt)?speech.sampledAt:0}:null};
  lastAcceptedAt=updatedAt=Date.now();
  return {ok:true};
 }
 function selectedManifest(){
  const entries={};if(!scene||!cloud.status().available)return entries;
  const manifest=cloud.readState().state?.assets||{};
  const keys=[];
  for(const side of ['left','right']){
   const id=scene.topic[side];if(!id)continue;
   for(const slot of ['aClosed','aOpen','idleClosed','idleOpen','oClosed','oOpen','eClosed','eOpen']){
    keys.push(id+':'+slot);
    if(id==='default')keys.push(slot);
   }
  }
  for(const id of [scene.topic.leftBackgroundId,scene.topic.rightBackgroundId,scene.topic.stageBackgroundId])if(id)keys.push('bg:'+id);
  for(const name of keys){
   const item=manifest[name];
   if(item&&/^[a-f0-9]{64}$/.test(item.hash)&&
      (item.type==='image/png'||item.type==='image/jpeg'||item.type==='image/webp'||item.type==='image/gif'))
    entries[name]={hash:item.hash,type:item.type};
  }
  return entries;
 }
 function getState(){
  return {scene:Date.now()-updatedAt<15000?scene:null,updatedAt,assets:selectedManifest()};
 }
 function asset(hash){
  if(!/^[a-f0-9]{64}$/.test(hash))return null;
  const match=Object.values(selectedManifest()).find(x=>x.hash===hash);
  if(!match)return null;
  return {data:cloud.getAsset(hash),type:match.type};
 }
 return {key,valid,accept,page,getState,asset};
}
module.exports={setupLiveRelay};