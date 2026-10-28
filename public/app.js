const $=sel=>document.querySelector(sel),$$=sel=>[...document.querySelectorAll(sel)];
const el={login:$('#login-view'),student:$('#student-view'),admin:$('#admin-view'),subtitle:$('#subtitle-text'),subBox:$('#subtitle'),avatar:$('#avatar-images'),placeholder:$('#avatar-placeholder')};
const VOICES=['Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat'];
let audioSegments=[];let role=null,config={},frames=Array(8).fill(false),ws=null,microphone=null,mediaStream=null,processor=null,sourceNode=null,micOn=false,micBusy=false,micRequestEpoch=0,callPending=false,audioContext=null,gain=null,analyser=null,nextAudioTime=0,animationId=0,blinkingUntil=0,nextBlink=0,currentFrame=-1,subtitleLine='',subtitleCarry='',spokenText='',smoothedEnergy=0,currentModel='',roleLoading=false;
const toast=(msg)=>{const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('show'),4500)};
async function api(url,opt={}){const r=await fetch(url,{credentials:'same-origin',...opt,headers:{...(opt.body&&! (opt.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...opt.headers}});let data;try{data=await r.json()}catch{data={error:'Respuesta inesperada'}}if(!r.ok)throw Error(data.error||`Error ${r.status}`);return data}
const post=(url,body)=>api(url,{method:'POST',body:JSON.stringify(body)});
const setVisible=view=>{for(const v of ['login','student','admin'])el[v].classList.toggle('hidden',view!==v);document.body.classList.toggle('student-active',view==='student');document.body.classList.toggle('login-active',view==='login')};
function setupAuth(){const form=$('#login-form');form.addEventListener('submit',async e=>{e.preventDefault();if(roleLoading)return;roleLoading=true;ensureAudio(true).catch(()=>{});const b=$('#login-btn');b.disabled=true;b.textContent='Ingresando…';try{const data=await post('/api/login',{password:$('#password').value});$('#password').value='';await restoreRole(data.role);if(data.role==='student')await startCall();}catch(err){toast(err.message)}finally{roleLoading=false;b.disabled=false;b.textContent='INGRESAR';}});$('#toggle-password').addEventListener('click',()=>{const t=$('#password'),b=$('#toggle-password'),visible=t.type==='password';t.type=visible?'text':'password';b.classList.toggle('showing',visible);b.setAttribute('aria-pressed',String(visible));b.setAttribute('aria-label',visible?'Ocultar contraseña':'Mostrar contraseña');b.title=visible?'Ocultar contraseña':'Mostrar contraseña';});
 $('#student-logout').addEventListener('click',logout);$('#admin-logout').addEventListener('click',logout)}
async function logout(){stopCall();try{await post('/api/logout',{})}catch{}role=null;setVisible('login')}
async function restoreRole(force){let me=await api('/api/me');role=force||me.role;if(role==='student'){
  connectingUi=true;callEnded=false;
  setVisible('student');updateConversationOverlay();setStatus('Conectando…');
  applySettings(me.config||{});setDocuments(me.documents||[]);await refreshFrames();
  if(connectingUi)setStatus('Conectando…');
 }else if(role==='admin'){setVisible('admin');await loadAdmin();}else setVisible('login');}
async function refreshFrames(){
 // Verificamos cada PNG por carga real, sin confiar en solicitudes HEAD.
 const parent=el.avatar;parent.replaceChildren();frames=Array(8).fill(false);
 const stamp=Date.now();
 const results=await Promise.all(Array.from({length:8},(_,i)=>new Promise(resolve=>{
  const img=document.createElement('img');img.className='avatar-frame';img.alt='';img.draggable=false;img.dataset.frame=String(i);
  img.onload=()=>{frames[i]=true;resolve(true)};
  img.onerror=()=>{frames[i]=false;resolve(false)};
  parent.appendChild(img);img.src=`/api/frames/${i}?v=${stamp}`;
 })));
 currentFrame=-1;showFrame(0);
 if(!results[0]){console.warn('No se encontró el fotograma 1. Revisá /data y PNG del administrador.');toast('No se cargó el personaje. Revisá las ocho imágenes en Administración.');}
}

function applySettings(c){
 config={...config,...c};
 document.documentElement.style.setProperty('--subtitle-size',(config.subtitleFont||20)+'px');
 document.documentElement.style.setProperty('--subtitle-width',(config.subtitleWidth||760)+'px');
 const s=(config.avatarScale??100)/100;
 // Si el PNG es muy alto, contain mantiene cabeza y torso completos dentro del escenario.
 el.avatar.style.setProperty('--avatar-scale',Math.max(.5,Math.min(1,s)));
 el.avatar.style.setProperty('--avatar-x',(config.avatarOffsetX||0)+'px');
 el.avatar.style.setProperty('--avatar-y',(config.avatarOffsetY||0)+'px');
 el.avatar.querySelectorAll('.avatar-frame').forEach(img=>{img.style.objectFit='contain';img.style.objectPosition='center center';});
}
function showFrame(index){
 let real=frames[index]?index:(frames[index%2]?index%2:(frames[0]?0:-1));
 if(real===currentFrame)return;
 currentFrame=real;
 const imgs=el.avatar.querySelectorAll('.avatar-frame');
 imgs.forEach(img=>img.classList.toggle('is-visible',Number(img.dataset.frame)===real));
 el.placeholder.classList.toggle('hidden',real>=0);
}
let frameVersions=Array(8).fill(0);
let captionRaw='',captionLines=[],captionCommitted=0,captionFinished=false,captionVisible=-1,captionWordCount=0;
let captionLastTextAt=0,firstAudioTime=null,finalAudioTime=0;
let sources=new Set(),connectAttempt=0,playbackGeneration=0;
let mutedByUser=false,keyboardOpen=false,callEnded=false,hasConnected=false,downloadNoticeTimer=null,callGeneration=0;
let connectingUi=false,reconnectTimer=null,reconnectAttempt=0,voiceStartTimer=null;
const startedDownloads=new Set();
// A cada línea se le asigna un inicio estimado según audio PCM, NO se escribe palabra por palabra.
const measureCanvas=document.createElement('canvas'),ctx=measureCanvas.getContext('2d');
function textFits(t){const f=parseInt(getComputedStyle(el.subBox).fontSize)||20;ctx.font='700 '+f+"px 'DM Sans',Arial,sans-serif";return ctx.measureText(t).width<=Math.max(50,el.subBox.clientWidth-35)}
function showSubtitle(text){el.subtitle.textContent=text||' ';el.subtitle.style.fontSize='';el.subtitle.style.transform='';if(text&&!textFits(text)){let n=parseInt(getComputedStyle(el.subBox).fontSize);while(n>13){n--;ctx.font='700 '+n+"px 'DM Sans',Arial,sans-serif";if(ctx.measureText(text).width<el.subBox.clientWidth-24){el.subtitle.style.fontSize=n+'px';break}}const fs=parseInt(el.subtitle.style.fontSize)||n;ctx.font='700 '+fs+"px 'DM Sans',Arial,sans-serif";const max=el.subBox.clientWidth-22,width=ctx.measureText(text).width;if(width>max)el.subtitle.style.transform='scaleX('+(max/width)+')';}}
function resetSubtitle(){captionRaw='';captionLines=[];captionCommitted=0;captionFinished=false;captionVisible=-1;captionWordCount=0;captionLastTextAt=0;showSubtitle(' ')}
function appendTranscription(text){
 if(!text)return;
 if(captionFinished){resetSubtitle();firstAudioTime=null;finalAudioTime=0;}
 const incoming=String(text);
 if(incoming.startsWith(captionRaw)&&captionRaw)captionRaw=incoming;
 else if(!captionRaw.endsWith(incoming)){
  let overlap=0;
  for(let k=Math.min(captionRaw.length,incoming.length);k>0;k--){if(captionRaw.endsWith(incoming.slice(0,k))){overlap=k;break}}
  const tail=incoming.slice(overlap);
  const space=overlap===0&&/[\p{L}\p{N}]$/u.test(captionRaw)&&/^[\p{L}\p{N}]/u.test(tail);
  captionRaw+=(space?' ':'')+tail;
 }
 captionLastTextAt=performance.now();commitCaptionLines(false);
}
function commitCaptionLines(flush){
 const words=captionRaw.trim().match(/\S+/gu)||[];let cursor=captionCommitted;
 while(cursor<words.length){
  let end=cursor+1;
  while(end<words.length&&end-cursor<7&&textFits(words.slice(cursor,end+1).join(' ')))end++;
  const last=words[end-1]||'',full=end-cursor>=7||end<words.length&&!textFits(words.slice(cursor,end+1).join(' '))||/[.!?;:]$/.test(last);
  if(!flush&&!full)break;
  captionLines.push({text:words.slice(cursor,end).join(' '),startWord:cursor,endWord:end});cursor=end;
 }
 captionCommitted=cursor;captionWordCount=words.length;
}
function beginResponseIfNeeded(){if(captionFinished&&audioContext&&audioContext.currentTime>=finalAudioTime-.04){resetSubtitle();firstAudioTime=null;finalAudioTime=0}}
function renderCaptions(){
 if(!audioContext||firstAudioTime===null)return;
 if(!captionFinished&&captionCommitted<captionWordCount&&performance.now()-captionLastTextAt>280)commitCaptionLines(true);
 // Gemini no devuelve marcas temporales por palabra: la línea aparece completa
 // cuando estimamos que empieza su primera palabra en el audio reproducido.
 const subtitleOffsetMs=Math.max(-1200,Math.min(1200,Number(config.subtitleDelay??0)));
 const elapsed=audioContext.currentTime-firstAudioTime-subtitleOffsetMs/1000;
 if(elapsed<0||!captionLines.length)return;
 const duration=Math.max(.35,finalAudioTime-firstAudioTime);
 const pace=captionFinished?Math.max(1.15,Math.min(3.15,captionWordCount/Math.max(.5,duration-.12))):2.15;
 const position=elapsed*pace;
 let target=-1;
 for(let k=0;k<captionLines.length;k++){
  if(captionLines[k].startWord<=position+.001)target=k;
  else break;
 }
 if(target>captionVisible){captionVisible=target;showSubtitle(captionLines[target].text)}
}
function pcmToFloat(base64){const s=atob(base64),v=new Float32Array(s.length/2);for(let i=0;i<v.length;i++){let x=s.charCodeAt(i*2)|(s.charCodeAt(i*2+1)<<8);if(x&0x8000)x-=0x10000;v[i]=x/32768;}return v}
async function ensureAudio(resume=true){
 audioContext ||= new (window.AudioContext||window.webkitAudioContext)({sampleRate:24000});
 if(!gain){gain=audioContext.createGain();gain.gain.value=.95;analyser=audioContext.createAnalyser();analyser.fftSize=1024;gain.connect(analyser);analyser.connect(audioContext.destination);}
 if(!animationId)animateMouth();
 // No bloquear la conexión mientras Chrome espera un gesto del usuario para permitir audio.
 if(resume&&audioContext.state==='suspended')audioContext.resume().catch(()=>{});
 return audioContext;
}
function playAudio(b64){
 if(!b64)return;
 const generation=playbackGeneration;
 ensureAudio(false).then(()=>{
  if(generation!==playbackGeneration||!audioContext)return;
  beginResponseIfNeeded();
  const pcm=pcmToFloat(b64),buff=audioContext.createBuffer(1,pcm.length,24000);
  buff.copyToChannel(pcm,0);
  const src=audioContext.createBufferSource();src.buffer=buff;src.connect(gain);
  const start=Math.max(audioContext.currentTime+(firstAudioTime===null?.48:.035),nextAudioTime);
  if(firstAudioTime===null)firstAudioTime=start;
  nextAudioTime=start+buff.duration;finalAudioTime=nextAudioTime;
  src.start(start);sources.add(src);src.onended=()=>{sources.delete(src);try{src.disconnect()}catch{}};
  if(connectingUi&&audioContext.state==='running'){
   const token=callGeneration;
   setTimeout(()=>{
    if(token===callGeneration&&audioContext?.state==='running'&&!callEnded&&ws?.readyState===WebSocket.OPEN)
     voicePlaybackStarted();
   },Math.max(0,Math.round((start-audioContext.currentTime)*1000)));
  }
  audioSegments.push({start,end:nextAudioTime,samples:pcm});
  audioSegments=audioSegments.filter(x=>x.end>audioContext.currentTime-.3);
 }).catch(e=>toast('No se pudo reproducir audio: '+e.message));
}
function stopPlayback(keepContext=false){
 playbackGeneration++;
 if(animationId){cancelAnimationFrame(animationId);animationId=0;}
 sources.forEach(src=>{try{src.stop();src.disconnect()}catch{}});sources.clear();
 if(!keepContext){
  if(audioContext){try{gain?.disconnect();analyser?.disconnect();audioContext.close().catch(()=>{})}catch{}}
  audioContext=null;analyser=null;gain=null;
 }nextAudioTime=0;audioSegments=[];smoothedEnergy=0;firstAudioTime=null;finalAudioTime=0;
 resetSubtitle();showFrame(0);
}
function scheduledEnergy(t){
 for(const segment of audioSegments){
  if(t<segment.start||t>=segment.end)continue;
  const i=Math.max(0,Math.floor((t-segment.start)*24000));
  let sum=0,n=0;
  for(let k=Math.max(0,i-300);k<Math.min(segment.samples.length,i+300);k+=4){sum+=segment.samples[k]*segment.samples[k];n++}
  return n?Math.sqrt(sum/n):0;
 }
 return 0;
}
function animateMouth(){
 animationId=requestAnimationFrame(animateMouth);
 renderCaptions();
 const now=performance.now();
 if(now>=nextBlink){blinkingUntil=now+105;nextBlink=now+(Math.max(1,Number(config.blinkRate||4))+Math.random()*1.4)*1000;}
 const blink=now<blinkingUntil?1:0;
 const offset=(Number(config.mouthDelay)||0)/1000;
 const energy=audioContext?scheduledEnergy(audioContext.currentTime-offset):0;
 const smoothing=Math.max(.05,Math.min(.95,Number(config.mouthSmoothing??40)/100));
 smoothedEnergy=smoothedEnergy*smoothing+energy*(1-smoothing);
 const sensitivity=Number(config.mouthSensitivity??48)/100;
 const threshold=.007+(1-sensitivity)*.025;
 const isPlaying=audioContext&&audioContext.currentTime>=firstAudioTime&&audioContext.currentTime<finalAudioTime;
 const talking=Boolean(isPlaying&&smoothedEnergy*(Number(config.mouthAmplitude??78)/80)>threshold);
 let shape=0;
 if(talking){
  // Aproximación A/O/E ligada al audio reproducido; Gemini no ofrece tiempos de fonemas.
  const t=audioContext.currentTime-firstAudioTime;
  const sequence=[1,2,1,3,1,2,3,1,2,3,1,3];
  const beat=Math.floor(t*7.5);
  shape=sequence[((beat%sequence.length)+sequence.length)%sequence.length];
  if(smoothedEnergy<threshold*1.12 && beat%2===0)shape=0;
 }

 const index=shape===0?blink:shape*2+blink;
 el.placeholder.classList.toggle('talking',talking);
 showFrame(index);
 audioSegments=audioSegments.filter(x=>x.end>(audioContext?.currentTime||0)-.2);
}
function setStatus(label,connected=false){$('#connection-label').textContent=label;$('.status-dot').classList.toggle('connected',connected);$('#call-btn').title=connected?'Colgar llamada':'Iniciar llamada';$('#call-btn').setAttribute('aria-label',connected?'Colgar llamada':'Iniciar llamada');}
function updateConversationOverlay(){
 const overlay=$('#conversation-overlay'),msg=$('#overlay-message'),stage=$('#stage');
 const loading=connectingUi,ended=callEnded&&!loading,muted=mutedByUser&&!ended&&!loading;
 stage.classList.toggle('connecting',loading);
 stage.classList.toggle('call-ended',ended);
 overlay.classList.toggle('is-connecting',loading);
 if(loading){
  msg.innerHTML='<span class="connecting-title">Conectando<span class="connecting-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></span>';
 }else if(ended){
  msg.innerHTML='Llamada terminada.<small>Pulsá el botón <strong class="accent-red">rojo</strong> para volver a conectarte.</small>';
 }else if(muted){
  msg.innerHTML='Estás muteado.<small>Presioná el botón <strong class="accent-yellow">amarillo</strong> para activar el micrófono.</small>';
 }
 overlay.classList.toggle('hidden',!(loading||ended||muted));
 $('#mic-btn').classList.toggle('is-muted',mutedByUser||keyboardOpen);
 $('#mic-btn').setAttribute('aria-pressed',String(mutedByUser||keyboardOpen));
 $('#mic-btn').setAttribute('aria-label',mutedByUser||keyboardOpen?'Activar micrófono':'Silenciar micrófono');
 $('#keyboard-btn').setAttribute('aria-pressed',String(keyboardOpen));
}
function voicePlaybackStarted(){
 if(!connectingUi||role!=='student'||callEnded)return;
 connectingUi=false;reconnectAttempt=0;
 if(voiceStartTimer){clearTimeout(voiceStartTimer);voiceStartTimer=null;}
 updateConversationOverlay();
 setStatus(micOn?'Escuchando':mutedByUser?'Silenciado':'Solo teclado',true);
}
function scheduleReconnect(){
 if(role!=='student'||callEnded)return;
 if(reconnectTimer)clearTimeout(reconnectTimer);
 connectingUi=true;hasConnected=false;
 updateConversationOverlay();
 setStatus(navigator.onLine===false?'Sin señal':'Conectando…');
 const delay=Math.min(1000*Math.pow(1.6,Math.min(reconnectAttempt,7)),10000);
 reconnectAttempt++;
 reconnectTimer=setTimeout(()=>{
  reconnectTimer=null;
  if(role!=='student'||callEnded)return;
  if(!navigator.onLine){scheduleReconnect();return;}
  if(!callPending&&!ws)void startCall({reconnect:true});
  else if(!ws)scheduleReconnect();
 },delay);
}
function hideDownloadNotice(){
 clearTimeout(downloadNoticeTimer);$('#download-notice').classList.add('hidden');
}
function showDownloadNotice(message){
 const n=$('#download-notice');$('#download-notice-text').textContent=message;
 n.classList.remove('hidden');clearTimeout(downloadNoticeTimer);
 downloadNoticeTimer=setTimeout(()=>n.classList.add('hidden'),5200);
}
async function downloadCVAutomatically(id){
 if(!id||startedDownloads.has(id))return;
 startedDownloads.add(id);
 try{
  const response=await fetch('/api/cv/'+encodeURIComponent(id),{credentials:'same-origin'});
  if(!response.ok)throw Error('No se pudo obtener el PDF (HTTP '+response.status+').');
  const blob=await response.blob();
  if(!blob.size)throw Error('El PDF llegó vacío.');
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='Mi_Curriculum.pdf';a.style.display='none';
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  showDownloadNotice('Tu CV se está descargando en este dispositivo.');
 }catch(error){
  startedDownloads.delete(id);
  showDownloadNotice('No se pudo descargar el CV.');
  toast(error.message||'Falló la descarga del PDF.');
 }
}
async function connectLive(){
 if(ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING))return;
 const attempt=++connectAttempt;
 setStatus('Conectando…');
 // El reproductor se prepara pero no se bloquea esperando permisos de autoplay.
 ensureAudio(false).catch(()=>{});
 const proto=location.protocol==='https:'?'wss':'ws';
 ws=new WebSocket(`${proto}://${location.host}/api/live`);
 const socket=ws;
 socket.onmessage=e=>{
  if(attempt!==connectAttempt)return;
  let m;try{m=JSON.parse(e.data)}catch{return}
  switch(m.type){
   case 'connected':
    currentModel=m.model;hasConnected=true;callEnded=false;
    setStatus(connectingUi?'Conectando…':micOn?'Escuchando':mutedByUser?'Silenciado':'Solo teclado',true);
    updateConversationOverlay();
    if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'start'}));
    clearTimeout(voiceStartTimer);
    voiceStartTimer=setTimeout(()=>{
     if(connectingUi&&!callEnded&&ws===socket&&socket.readyState===WebSocket.OPEN)
      socket.close();
    },20000);
    break;
   case 'transcript':appendTranscription(m.text);break;
   case 'audio':playAudio(m.pcm);break;
   case 'input_transcript':if(m.text?.trim()&&micOn)setStatus('Te escucho',true);break;
   case 'turn_complete':captionFinished=true;commitCaptionLines(true);if(micOn&&!connectingUi)setStatus('Escuchando',true);break;
   case 'profile':break;
   case 'document':setDocuments([{id:m.id}]);void downloadCVAutomatically(m.id);break;
   case 'interrupted':stopPlayback(true);break;
   case 'error':toast(m.message||'Error en Gemini Live');setStatus('Error');stopMicrophone();break;
   case 'notice':toast(m.message);break;
   case 'closed':
    if(!callEnded&&socket.readyState===WebSocket.OPEN)socket.close();
    break;
  }
 };
 socket.onclose=()=>{
  if(attempt!==connectAttempt)return;
  ws=null;hasConnected=false;stopMicrophone();stopPlayback();
  if(!callEnded)scheduleReconnect();
 };
 socket.onerror=()=>{if(attempt!==connectAttempt)return;connectingUi=true;updateConversationOverlay();setStatus('Conectando…')};
}
function stopCall(){
 clearTimeout(reconnectTimer);reconnectTimer=null;
 clearTimeout(voiceStartTimer);voiceStartTimer=null;
 connectAttempt++;callGeneration++;hasConnected=false;callEnded=true;connectingUi=false;reconnectAttempt=0;stopMicrophone();
 if(ws){ws.onclose=null;try{ws.close()}catch{}ws=null}
 stopPlayback();setStatus('Desconectado');updateConversationOverlay();
}
async function startMicrophone(){
 if(micOn||micBusy)return micOn;
 micBusy=true;const epoch=micRequestEpoch;let stream=null,context=null;
 try{
  if(!navigator.mediaDevices?.getUserMedia)throw Error('El micrófono requiere un navegador con HTTPS.');
  // Desbloquea la salida de audio a partir del toque de la persona.
  await ensureAudio(true);
  // El pedido de permisos ocurre ANTES de abrir Gemini y generar el saludo.
  stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  if(epoch!==micRequestEpoch){stream.getTracks().forEach(t=>t.stop());return false;}
  context=new (window.AudioContext||window.webkitAudioContext)();
  if(context.state==='suspended')await context.resume();
  const node=context.createMediaStreamSource(stream),proc=context.createScriptProcessor(2048,1,1),silent=context.createGain();
  silent.gain.value=0;node.connect(proc);proc.connect(silent);silent.connect(context.destination);
  mediaStream=stream;microphone=context;sourceNode=node;processor=proc;
  proc.onaudioprocess=e=>{
   if(!micOn||!ws||ws.readyState!==WebSocket.OPEN||ws.bufferedAmount>200000)return;
   const input=e.inputBuffer.getChannelData(0),rate=context.sampleRate,ratio=rate/16000,n=Math.floor(input.length/ratio),out=new Int16Array(n);
   for(let j=0;j<n;j++){const from=Math.floor(j*ratio),to=Math.min(input.length,Math.floor((j+1)*ratio));let sum=0;for(let k=from;k<to;k++)sum+=input[k];const v=Math.max(-1,Math.min(1,sum/Math.max(1,to-from)));out[j]=v<0?v*32768:v*32767;}
   const bytes=new Uint8Array(out.buffer);let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
   ws.send(JSON.stringify({type:'audio',pcm:btoa(binary)}));
  };
  micOn=true;$('#mic-btn').classList.add('active');$('#mic-btn').setAttribute('aria-pressed','true');
  $('#mic-btn').setAttribute('aria-label','Silenciar micrófono');
  if(ws?.readyState===WebSocket.OPEN)setStatus('Escuchando',true);
  updateConversationOverlay();return true;
 }catch(e){
  stream?.getTracks().forEach(t=>t.stop());context?.close().catch(()=>{});
  toast(e?.name==='NotAllowedError'?'Permiso de micrófono denegado. Permitilo en Chrome o usá el teclado.':'Micrófono: '+String(e?.message||e));
  return false;
 }finally{micBusy=false}
}
function stopMicrophone(){
 micRequestEpoch++;
 if(micOn&&ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'audio_end'}));
 micOn=false;try{processor?.disconnect();sourceNode?.disconnect()}catch{}
 mediaStream?.getTracks().forEach(t=>t.stop());microphone?.close().catch(()=>{});
 processor=null;sourceNode=null;mediaStream=null;microphone=null;
 $('#mic-btn').classList.remove('active');$('#mic-btn').setAttribute('aria-pressed','false');
 $('#mic-btn').setAttribute('aria-label','Activar micrófono');
 if(ws?.readyState===WebSocket.OPEN)setStatus(mutedByUser?'Silenciado':'Solo teclado',true);
 updateConversationOverlay();
}
async function startCall({reconnect=false}={}){
 if(callPending||ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING))return;
 const thisCall=++callGeneration;
 callPending=true;callEnded=false;hasConnected=false;connectingUi=true;
 clearTimeout(reconnectTimer);reconnectTimer=null;
 if(!reconnect){
  mutedByUser=false;keyboardOpen=false;
  $('#text-form').classList.add('hidden');
 }
 updateConversationOverlay();setStatus('Conectando…');
 try{
  let micReady=false;
  if(!mutedByUser&&!keyboardOpen)micReady=await startMicrophone();
  if(thisCall!==callGeneration)return;
  if(!micReady&&!mutedByUser&&!keyboardOpen){
   mutedByUser=true;
   toast('Permití el micrófono en Chrome o usá el teclado.');
  }
  updateConversationOverlay();
  if(thisCall===callGeneration)await connectLive();
 }catch(e){
  if(thisCall!==callGeneration)return;
  console.warn('Reconexión de llamada:',e);
  stopMicrophone();connectingUi=true;updateConversationOverlay();
  scheduleReconnect();
 }finally{callPending=false}
}
let savedDocuments=[];
function setDocuments(docs){savedDocuments=Array.isArray(docs)?docs:[];}
function setupStudent(){
 $('#call-btn').onclick=async()=>{
  if(callPending||ws&&(ws.readyState===WebSocket.CONNECTING||ws.readyState===WebSocket.OPEN))stopCall();
  else await startCall();
 };
 $('#mic-btn').onclick=async()=>{
  if(!ws||ws.readyState!==WebSocket.OPEN){toast('Pulsá el botón rojo para conectarte.');return;}
  mutedByUser=!mutedByUser;
  if(mutedByUser)stopMicrophone();
  else if(!keyboardOpen){
   const ok=await startMicrophone();
   if(!ok)mutedByUser=true;
  }
  updateConversationOverlay();
 };
 $('#keyboard-btn').onclick=async()=>{
  keyboardOpen=!keyboardOpen;
  $('#text-form').classList.toggle('hidden',!keyboardOpen);
  if(keyboardOpen){
   stopMicrophone();
   $('#text-message').focus();
  }else if(!mutedByUser&&ws?.readyState===WebSocket.OPEN){
   const ok=await startMicrophone();
   if(!ok)mutedByUser=true;
  }
  updateConversationOverlay();
 };
 $('#text-form').onsubmit=e=>{
  e.preventDefault();const inp=$('#text-message'),txt=inp.value.trim();if(!txt)return;
  if(!ws||ws.readyState!==WebSocket.OPEN){toast('Conectá la llamada con el botón rojo.');return;}
  ws.send(JSON.stringify({type:'text',text:txt}));inp.value='';
  // El teclado permanece abierto tras enviar y se recupera el foco del campo.
  keyboardOpen=true;$('#text-form').classList.remove('hidden');
  updateConversationOverlay();requestAnimationFrame(()=>inp.focus({preventScroll:true}));
 };
 $('#reset-btn').onclick=()=>$('#reset-modal').classList.remove('hidden');
 $('#cancel-reset').onclick=()=>$('#reset-modal').classList.add('hidden');
 $('#confirm-reset').onclick=async()=>{
  const btn=$('#confirm-reset');btn.disabled=true;
  try{
   ensureAudio(true).catch(()=>{});
   stopCall();
   connectingUi=true;callEnded=false;updateConversationOverlay();setStatus('Conectando…');
   await post('/api/reset',{confirm:true});
   $('#reset-modal').classList.add('hidden');
   mutedByUser=false;keyboardOpen=false;callEnded=false;
   setDocuments([]);startedDownloads.clear();hideDownloadNotice();
   resetSubtitle();updateConversationOverlay();
   await startCall();
  }catch(e){toast(e.message);updateConversationOverlay()}
  finally{btn.disabled=false}
 };
}
// Administración: lista de ocho fotogramas y vista previa responsive.
const frameDescriptions=['Ojos abiertos · Reposo','Ojos cerrados · Reposo','Ojos abiertos · A','Ojos cerrados · A','Ojos abiertos · O','Ojos cerrados · O','Ojos abiertos · E','Ojos cerrados · E'];
function buildFrames(){const root=$('#frames-grid');root.innerHTML='';frameDescriptions.forEach((name,i)=>{const card=document.createElement('div');card.className='frame-card';card.innerHTML=`<div class="frame-thumb"><span class="frame-num">${String(i+1).padStart(2,'0')}</span><span class="frame-placeholder">✧</span><img class="hidden" alt="Fotograma ${i+1}" /></div><strong>${name}</strong><small>PNG · mismo encuadre</small><label class="frame-upload">${frames[i]?'Reemplazar PNG':'Subir PNG'} <input type="file" accept="image/png" aria-label="Cargar imagen ${i+1}"></label>`;if(frames[i]){const img=card.querySelector('img');img.src=`/api/frames/${i}?v=${Date.now()}`;img.classList.remove('hidden');card.querySelector('.frame-placeholder').classList.add('hidden')};card.querySelector('input').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;const fd=new FormData();fd.append('image',file);try{const out=await api(`/api/admin/frames/${i}`,{method:'POST',body:fd});frames[i]=true;frameVersions[i]++;buildFrames();updatePreviewImage();toast(`Imagen ${i+1} guardada: ${out.width} × ${out.height} px`);}catch(err){toast(err.message)}};root.appendChild(card)});$('#frames-count').textContent=`${frames.filter(Boolean).length} / 8 cargadas`}
function updatePreviewImage(){const img=$('#admin-preview-img');if(frames[0]){img.src=`/api/frames/0?v=${frameVersions[0]||0}`;img.classList.remove('hidden');$('.avatar-mini-fallback').classList.add('hidden')}else{img.classList.add('hidden');$('.avatar-mini-fallback').classList.remove('hidden')}const s=Number($('[data-setting="avatarScale"]')?.value||100)/100, x=Number($('[data-setting="avatarOffsetX"]')?.value||0),y=Number($('[data-setting="avatarOffsetY"]')?.value||0);img.style.transform=`translate(${x}px,${y}px) scale(${s})`;img.style.objectFit=$('[data-setting="avatarFit"]')?.value||'contain';}
function syncOutputs(){for(const o of $$('output[data-for]')){const inp=$(`[data-setting="${o.dataset.for}"]`);if(inp)o.textContent=inp.value+((o.dataset.for==='mouthDelay'||o.dataset.for==='subtitleDelay')?' ms':o.dataset.for==='blinkRate'?' s':o.dataset.for==='subtitleWidth'?' px':o.dataset.for==='subtitleFont'?' px':'');}updatePreviewImage()}
function fillVoiceSelector(list, current){
 const select=$('#voice-select');
 const all=Array.isArray(list)&&list.length?list:VOICES;
 const valid=all.filter(v=>typeof v==='string'&&v.trim());
 select.replaceChildren(...valid.map(v=>new Option(v,v)));
 const selected=valid.includes(current)?current:(valid.includes('Aoede')?'Aoede':valid[0]);
 if(selected)select.value=selected;
 select.disabled=!valid.length;
 return selected;
}
async function loadAdmin(){
 fillVoiceSelector(VOICES,config.voice||'Aoede');
 const data=await api('/api/admin/config');config=data.config||{};frames=data.frames||Array(8).fill(false);
 buildFrames();
 for(const inp of $$('[data-setting]')){
  if(inp.dataset.setting==='voice')continue;
  const val=config[inp.dataset.setting];if(val!==undefined&&val!==null)inp.value=val;
 }
 config.voice=fillVoiceSelector(data.voices,config.voice);
 syncOutputs();
 if(!data.geminiReady)$('#voice-test-status').textContent='Falta configurar GEMINI_API_KEY en Railway.';
}

function setupAdmin(){$$('#admin-nav .nav-item').forEach(b=>b.onclick=()=>{const name=b.dataset.pane;$$('#admin-nav .nav-item').forEach(x=>x.classList.toggle('selected',x===b));$$('.admin-pane').forEach(p=>p.classList.toggle('hidden',p.dataset.pane!==name));$('#admin-title').innerHTML={appearance:'Personaje y <em>vista previa</em>',voice:'Voz e <em>inteligencia</em>',behavior:'Prompt del <em>sistema</em>',accessibility:'Accesibilidad y <em>sincronía</em>'}[name];});$$('[data-setting]').forEach(inp=>inp.addEventListener('input',syncOutputs));$$('.device-btn').forEach(b=>b.onclick=()=>{$$('.device-btn').forEach(x=>x.classList.toggle('selected',x===b));$('#admin-preview').classList.toggle('mobile',b.dataset.device==='mobile')});$('#save-settings').onclick=async()=>{const next={};for(const i of $$('[data-setting]'))next[i.dataset.setting]=i.type==='range'?Number(i.value):i.value;if(!next.voice||!VOICES.includes(next.voice))next.voice='Aoede';try{const saved=await api('/api/admin/config',{method:'PUT',body:JSON.stringify({config:next})});config=saved.config;toast('Configuración guardada en Railway.')}catch(e){toast(e.message)}};$('#test-voice').onclick=async()=>{const btn=$('#test-voice'),status=$('#voice-test-status');btn.disabled=true;btn.textContent='Preparando muestra…';status.textContent='Generando audio con la voz seleccionada…';try{const r=await fetch('/api/admin/voice-sample',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voice:$('#voice-select').value||'Aoede'})});if(!r.ok){const data=await r.json();throw Error(data.error||'Error de voz')}const blob=await r.blob(),url=URL.createObjectURL(blob),a=new Audio(url);a.onended=()=>URL.revokeObjectURL(url);await a.play();status.textContent=`Reproduciendo · ${r.headers.get('X-Gemini-Model')||'Gemini Live'}`;}catch(e){status.textContent='No se pudo generar la muestra: '+e.message;toast(e.message)}finally{btn.disabled=false;btn.textContent='▶ Escuchar prueba'}}}
setupAuth();setupStudent();setupAdmin();
const isLocal=['localhost','127.0.0.1'].includes(location.hostname);
if(isLocal&&new URLSearchParams(location.search).get('demo')){const demo=new URLSearchParams(location.search).get('demo');if(demo==='student'){setVisible('student');applySettings({subtitleFont:20,subtitleWidth:760,avatarScale:100});showFrame(0);setStatus('Conectado',true);$('#connection-label').textContent='Vista previa';}else if(demo==='admin'){setVisible('admin');config={avatarScale:100,avatarOffsetX:0,avatarOffsetY:0,avatarFit:'contain',model:'gemini-3.8-live',fallback:'gemini-3.1-flash-live-preview',voice:'Aoede'};buildFrames();syncOutputs();}else setVisible('login');}
else restoreRole().then(()=>{if(role==='student')void startCall();}).catch(()=>setVisible('login'));
window.addEventListener('offline',()=>{
 if(role!=='student'||callEnded)return;
 connectingUi=true;updateConversationOverlay();setStatus('Sin señal');
 if(ws&&ws.readyState!==WebSocket.CLOSED)ws.close();
 else scheduleReconnect();
});
window.addEventListener('online',()=>{
 if(role!=='student'||callEnded||!connectingUi)return;
 clearTimeout(reconnectTimer);reconnectTimer=null;
 if(!ws&&!callPending)void startCall({reconnect:true});
});