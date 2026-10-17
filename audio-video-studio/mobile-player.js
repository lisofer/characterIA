"use strict";
// Mobile Persona Studio player. The Generate touch unlocks a persistent AudioContext,
// allowing playback after asynchronous Fish generation on Chrome Android.
let audioContext=null, activePlayback=null, playingSync=null, shownPose=-1;
let pendingAutoPlayJob="",pendingVideoDownloadJob="",pollBusy=false,playToken=0;
const decodedAudio=new Map(),syncCache=new Map();

function stageMessage(message=""){
 const el=$("stage-overlay");
 el.hidden=!message;
 el.textContent=message;
}
function activeJob(){return findBy(data.generations,currentJob)}
function updateStageButtons(){
 const j=activeJob(),ready=Boolean(j?.audio_file);
 $("download-mp3").disabled=!ready;
 $("download-mp4").disabled=!ready||j?.status==="rendering";
 if(!j){stageMessage();return}
 if(["queued","generating"].includes(j.status)){stageMessage("Generando voz…");return}
 if(j.status==="rendering"){stageMessage("Preparando MP4…");return}
 if(!ready&&["failed","interrupted"].includes(j.status)){stageMessage("No se pudo generar la voz");return}
 if(j.status==="video_failed"){stageMessage("No se pudo exportar el video");return}
 stageMessage();
}
function idlePose(){
 const set=findBy(data.outfits,selectedOutfit);
 if(!set)return -1;
 return set.slots?.[3]?3:(set.slots||[]).findIndex(Boolean);
}
function setIdlePreview(){
 const set=findBy(data.outfits,selectedOutfit),idx=idlePose();
 if(!set||idx<0)return;
 const img=$("preview-avatar"),url="/api/outfits/"+encodeURIComponent(set.id)+"/image/"+idx;
 if(img.getAttribute("src")!==url)img.src=url;
 img.hidden=false;
 shownPose=idx;
}
function stopPlayback(reset=true){
 ++playToken;
 if(activePlayback){
  try{activePlayback.source.stop(0)}catch(e){}
  try{activePlayback.source.disconnect()}catch(e){}
  activePlayback=null;
 }
 playingSync=null;
 if(reset)setIdlePreview();
}
function selectionChanged(){
 stopPlayback();
 pendingAutoPlayJob="";pendingVideoDownloadJob="";currentJob="";
 renderCreate();
}
function getAudioContext(){
 if(!audioContext){
  const C=window.AudioContext||window.webkitAudioContext;
  if(!C)throw new Error("El navegador no admite Web Audio.");
  audioContext=new C();
 }
 return audioContext;
}
function unlockAudio(){
 try{
  const ctx=getAudioContext();
  if(ctx.state==="suspended")void ctx.resume().catch(()=>{});
  // Starting one silent sample inside the touch also unlocks iOS/Android engines.
  const source=ctx.createBufferSource();
  source.buffer=ctx.createBuffer(1,1,22050);
  source.connect(ctx.destination);
  source.start();
 }catch(err){console.warn("Audio no iniciado",err)}
}
async function decodedForJob(id,ctx){
 if(decodedAudio.has(id))return decodedAudio.get(id);
 const response=await fetch("/api/generations/"+id+"/file/mp3",{credentials:"same-origin",cache:"no-store"});
 if(!response.ok)throw new Error("No se pudo abrir el MP3 ("+response.status+").");
 const buffer=await ctx.decodeAudioData(await response.arrayBuffer());
 decodedAudio.set(id,buffer);
 if(decodedAudio.size>3)decodedAudio.delete(decodedAudio.keys().next().value);
 return buffer;
}
function syncFrame(){
 const playing=activePlayback;
 if(!playing||!playingSync||playing.id!==currentJob)return;
 const events=playingSync.events;
 if(!events||!events.length)return;
 const seconds=Math.max(0,audioContext.currentTime-playing.startedAt);
 let lo=0,hi=events.length-1;
 while(lo<hi){
  const mid=Math.ceil((lo+hi)/2);
  if(events[mid][0]<=seconds)lo=mid;else hi=mid-1;
 }
 const pose=events[lo][1];
 if(pose!==shownPose){
  const set=findBy(data.outfits,selectedOutfit);
  const index=set?.slots?.[pose]?pose:idlePose();
  if(set&&index>=0){
   const img=$("preview-avatar");
   const url="/api/outfits/"+encodeURIComponent(set.id)+"/image/"+index;
   if(img.getAttribute("src")!==url)img.src=url;
   img.hidden=false;
  }
  shownPose=pose;
 }
 if(seconds<=playing.duration+.1&&activePlayback===playing)requestAnimationFrame(syncFrame);
}
async function playJob(id){
 const j=findBy(data.generations,id);
 if(!j?.audio_file)return;
 stopPlayback(false);
 const token=playToken,ctx=getAudioContext();
 const [timeline,buffer]=await Promise.all([
  syncCache.has(id)?Promise.resolve(syncCache.get(id)):api("/api/generations/"+id+"/sync"),
  decodedForJob(id,ctx)
 ]);
 if(token!==playToken||currentJob!==id)return;
 syncCache.set(id,timeline);
 if(ctx.state!=="running"){
  try{await ctx.resume()}catch(err){}
 }
 if(ctx.state!=="running"){
  stageMessage("Tocá el personaje para escuchar");
  return;
 }
 if(token!==playToken||currentJob!==id)return;
 const source=ctx.createBufferSource();
 source.buffer=buffer;
 source.connect(ctx.destination);
 const startedAt=ctx.currentTime+.02;
 playingSync=timeline;
 shownPose=-1;
 activePlayback={source,id,startedAt,duration:buffer.duration};
 source.onended=()=>{
  if(activePlayback?.source===source){
   activePlayback=null;playingSync=null;setIdlePreview();
  }
  try{source.disconnect()}catch(err){}
 };
 source.start(startedAt,0);
 stageMessage();
 requestAnimationFrame(syncFrame);
}
function startDownload(url,filename){
 const a=document.createElement("a");
 a.href=url;
 a.download=filename;
 document.body.append(a);
 a.click();
 a.remove();
}
async function createGeneration(text){
 text=String(text||"").trim();
 if(!currentChar()||!selectedOutfit)throw new Error("Elegí un personaje y un conjunto.");
 if(!text)throw new Error("Escribí el texto que va a decir.");
 const result=await api("/api/generations",{
  method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({character_id:currentChar(),outfit_id:selectedOutfit,background_id:selectedBackground,text})
 });
 stopPlayback();
 currentJob=result.id;
 pendingAutoPlayJob=result.id;
 pendingVideoDownloadJob="";
 stageMessage("Generando voz…");
 await refreshJobs();
 return result;
}
async function refreshJobs(){
 if(pollBusy)return;
 pollBusy=true;
 try{
  const result=await api("/api/generations");
  const before=JSON.stringify(data.generations.map(j=>[j.id,j.status,j.audio_file,j.video_file,j.error]));
  data.generations=result.generations;
  const after=JSON.stringify(data.generations.map(j=>[j.id,j.status,j.audio_file,j.video_file,j.error]));
  if(before!==after)renderLibrary();
  updateStageButtons();
  const j=activeJob();
  if(pendingAutoPlayJob && j?.id===pendingAutoPlayJob){
   if(j.audio_file){
    pendingAutoPlayJob="";
    playJob(j.id).catch(err=>{
     stageMessage("Tocá el personaje para escuchar");
     toast("El audio está listo. Tocá el personaje para escucharlo.",true);
     console.warn(err);
    });
   }else if(["failed","interrupted"].includes(j.status)){
    pendingAutoPlayJob="";
    toast(j.error||"Fish no pudo generar la voz.",true);
   }
  }
  if(pendingVideoDownloadJob && j?.id===pendingVideoDownloadJob){
   if(j.video_file){
    pendingVideoDownloadJob="";
    stageMessage();
    startDownload("/api/generations/"+j.id+"/file/mp4?download=1","personaje.mp4");
    toast("MP4 listo. Si Chrome no lo descargó, tocá MP4 de nuevo.");
   }else if(j.status==="video_failed"){
    pendingVideoDownloadJob="";
    toast(j.error||"No se pudo exportar el MP4.",true);
   }
  }
 }finally{pollBusy=false}
}
function setupPlayer(){
 $("character-choice").addEventListener("change",()=>{selectedOutfit="";selectionChanged()});
 $("outfit-choice").addEventListener("change",()=>{selectedOutfit=$("outfit-choice").value;selectionChanged()});
 $("background-choice").addEventListener("change",()=>{selectedBackground=$("background-choice").value;selectionChanged()});
 $("preview-scene").addEventListener("click",()=>{
  if(!activeJob()?.audio_file)return;
  unlockAudio();
  playJob(currentJob).catch(err=>{stageMessage("Tocá para volver a intentar");toast(err.message,true)});
 });
 $("generate").addEventListener("click",async()=>{
  unlockAudio();
  const btn=$("generate");busy(btn);
  try{await createGeneration($("speech-text").value)}
  catch(err){toast(err.message,true);updateStageButtons()}
  finally{busy(btn,false)}
 });
 $("download-mp3").addEventListener("click",()=>{
  const j=activeJob();
  if(j?.audio_file)startDownload("/api/generations/"+j.id+"/file/mp3?download=1","personaje.mp3");
 });
 $("download-mp4").addEventListener("click",async()=>{
  const j=activeJob();
  if(!j?.audio_file)return;
  if(j.video_file){
   startDownload("/api/generations/"+j.id+"/file/mp4?download=1","personaje.mp4");
   return;
  }
  if(j.status==="rendering")return;
  $("download-mp4").disabled=true;
  try{
   pendingVideoDownloadJob=j.id;
   await api("/api/generations/"+j.id+"/video",{method:"POST"});
   stageMessage("Preparando MP4…");
   await refreshJobs();
  }catch(err){
   pendingVideoDownloadJob="";
   toast(err.message,true);updateStageButtons();
  }
 });
}
