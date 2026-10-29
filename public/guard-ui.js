/* Erik · Gemini 3.8 Live · captura continua como NEXO CV.
   Una sola captura getUserMedia: no hay reinicios de reconocimiento de Chrome.
   Se muestran exclusivamente los subtítulos de Erik. */
const one=s=>document.querySelector(s),clean=x=>String(x||'').normalize('NFC').trim();
const guardVisual=one('#guard-avatar'),status=one('#guard-status');
const frameDescriptions=['Abiertos · reposo','Cerrados · reposo','Abiertos · A','Cerrados · A','Abiertos · O','Cerrados · O','Abiertos · E','Cerrados · E'];
let guardConfig={},guardFrames=[],guardFramesFullyReady=false,guardFrameLoadEpoch=0;
let guardActive=false,guardMuted=false,guardNeedsGesture=false,guardEpoch=0,guardTalking=false;
let painted=-1,rAF=0,nextBlink=0,blinkEnd=0,amplitude=0,spokenAt=0;
let ws=null,liveReady=false,pendingIntent=null,connectionRetries=0;
let audioContext=null,audioGain=null,voiceAnalyser=null,nextAudioTime=0,outputCaption='';
let nextCaptionIsNewTurn=true,openingGreeting=true,openingPlaybackPending=false,lastTurnCompleted=false;
let scheduledSources=new Set(),tailTimer=null;
let micStream=null,micContext=null,micSource=null,micProcessor=null,micSilent=null;
let micOn=false,micBusy=false,micRequestEpoch=0,micPromptAttempted=false;
let pendingInput='',inputTimer=null;
const statusText=s=>{if(status)status.textContent=String(s||'')};
const isLoginVisible=()=>!one('#login-view')?.classList.contains('hidden');
async function readJSON(url,opt={}){const r=await fetch(url,{credentials:'same-origin',...opt});const v=await r.json().catch(()=>({}));if(!r.ok)throw Error(v.error||'Error '+r.status);return v}
function setMuteAppearance(){
 const btn=one('#guard-toggle'),dock=one('#guard-dock');
 dock?.classList.toggle('is-muted',guardMuted);btn?.setAttribute('aria-pressed',String(guardMuted));
 const label=guardMuted?'Volver a hablar con Erik':guardNeedsGesture?'Activar el micrófono y el sonido':'Silenciar a Erik y el micrófono';
 btn?.setAttribute('aria-label',label);btn?.setAttribute('title',label);
 const hint=one('#guard-hint');if(hint)hint.textContent=label;
}
function pauseMic(){
 micOn=false;micStream?.getAudioTracks().forEach(t=>{t.enabled=false});
}
function releaseMic(){
 pauseMic();micRequestEpoch++;micPromptAttempted=false;
 try{micProcessor?.disconnect();micSource?.disconnect();micSilent?.disconnect()}catch{}
 micStream?.getTracks().forEach(t=>t.stop());micContext?.close().catch(()=>{});
 micStream=null;micContext=null;micSource=null;micProcessor=null;micSilent=null;
}
async function startMic(gesture=false){
 if(!guardActive||guardMuted||!isLoginVisible())return false;
 if(micOn&&micStream?.getAudioTracks().some(t=>t.readyState==='live')){
  if(micContext?.state==='suspended'&&gesture)await micContext.resume().catch(()=>{});
  guardNeedsGesture=micContext?.state!=='running';
  setMuteAppearance();
  return !guardNeedsGesture;
 }
 if(micStream&&micContext&&micProcessor&&micStream.getAudioTracks().some(t=>t.readyState==='live')){
  if(micContext.state==='suspended'&&gesture)await micContext.resume().catch(()=>{});
  micStream.getAudioTracks().forEach(t=>{t.enabled=true});
  micOn=true;guardNeedsGesture=micContext.state!=='running';setMuteAppearance();return !guardNeedsGesture;
 }
 if(micBusy||(!gesture&&micPromptAttempted))return false;
 micBusy=true;micPromptAttempted=true;const epoch=micRequestEpoch;let stream=null,ctx=null;
 try{
  if(!navigator.mediaDevices?.getUserMedia)throw Error('Se necesita un navegador con micrófono.');
  stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  if(epoch!==micRequestEpoch||!guardActive||guardMuted){stream.getTracks().forEach(t=>t.stop());return false;}
  ctx=new (window.AudioContext||window.webkitAudioContext)();
  if(ctx.state==='suspended'&&gesture)await ctx.resume().catch(()=>{});
  const src=ctx.createMediaStreamSource(stream),proc=ctx.createScriptProcessor(2048,1,1),silent=ctx.createGain();
  silent.gain.value=0;src.connect(proc);proc.connect(silent);silent.connect(ctx.destination);
  micStream=stream;micContext=ctx;micSource=src;micProcessor=proc;micSilent=silent;
  proc.onaudioprocess=e=>{
   if(!micOn||guardMuted||!guardActive||!liveReady||!ws||
     ws.readyState!==WebSocket.OPEN||ws.bufferedAmount>180000||openingGreeting||document.hidden||
     document.activeElement===one('#password'))return;
   const input=e.inputBuffer.getChannelData(0),ratio=ctx.sampleRate/16000,n=Math.floor(input.length/ratio),out=new Int16Array(n);
   for(let j=0;j<n;j++){
    const a=Math.floor(j*ratio),b=Math.min(input.length,Math.floor((j+1)*ratio));
    let sum=0;for(let k=a;k<b;k++)sum+=input[k];
    const v=Math.max(-1,Math.min(1,sum/Math.max(1,b-a)));
    out[j]=v<0?v*32768:v*32767;
   }
   const bytes=new Uint8Array(out.buffer);let str='';
   for(let k=0;k<bytes.length;k++)str+=String.fromCharCode(bytes[k]);
   ws.send(JSON.stringify({type:'audio',pcm:btoa(str)}));
  };
  stream.getAudioTracks().forEach(t=>t.addEventListener('ended',()=>{
   if(guardActive&&!guardMuted){micOn=false;guardNeedsGesture=true;setMuteAppearance();}
  }));
  micOn=true;guardNeedsGesture=ctx.state!=='running';setMuteAppearance();return !guardNeedsGesture;
 }catch(err){
  stream?.getTracks().forEach(t=>t.stop());ctx?.close().catch(()=>{});
  guardNeedsGesture=true;setMuteAppearance();
  statusText('Soy Erik. Tocame para habilitar el micrófono, o escribí tu contraseña.');
  return false;
 }finally{micBusy=false;}
}
function clearInput(){clearTimeout(inputTimer);inputTimer=null;pendingInput='';}
function stopPlayback(){
 clearTimeout(tailTimer);tailTimer=null;
 for(const src of scheduledSources){try{src.stop();src.disconnect()}catch{}}
 scheduledSources.clear();nextAudioTime=0;guardTalking=false;amplitude=0;outputCaption='';nextCaptionIsNewTurn=true;lastTurnCompleted=false;displayFrame(0);
}
function stopGuard({hide=false}={}){
 guardEpoch++;releaseMic();clearInput();stopPlayback();
 guardActive=false;guardMuted=false;liveReady=false;pendingIntent=null;guardNeedsGesture=false;openingGreeting=true;openingPlaybackPending=false;
 if(ws){const previous=ws;ws=null;try{previous.close()}catch{}}
 if(rAF)cancelAnimationFrame(rAF);rAF=0;painted=-1;
 if(hide)one('#guard-dock')?.classList.add('hidden');setMuteAppearance();
}
function displayFrame(index){
 const frame=(guardFramesFullyReady?guardFrames[index]:null)||guardFrames[0];
 if(!frame||!frame.complete||!frame.naturalWidth)return;
 const next=Number(frame.dataset.frame);if(next===painted)return;
 painted=next;guardFrames.forEach(x=>x?.classList.toggle('is-visible',x===frame));
 one('#guard-fallback')?.classList.add('hidden');
}
function renderGuard(){
 if(!guardActive||!isLoginVisible()){rAF=0;return;}
 rAF=requestAnimationFrame(renderGuard);const now=performance.now();
 if(now>nextBlink){blinkEnd=now+130;nextBlink=now+(Number(guardConfig.blinkRate)||4)*1000+Math.random()*900;}
 const blink=now<blinkEnd?1:0;let shape=0;
 if(!guardMuted&&guardTalking&&audioContext?.state==='running'&&audioContext.currentTime<nextAudioTime+.04){
  let energy=.05;
  if(voiceAnalyser){
   const sample=new Float32Array(voiceAnalyser.fftSize);
   voiceAnalyser.getFloatTimeDomainData(sample);let sum=0;
   for(let i=0;i<sample.length;i+=4)sum+=sample[i]*sample[i];
   energy=Math.sqrt(sum/Math.max(1,sample.length/4));
  }
  const sm=Math.max(.05,Math.min(.95,Number(guardConfig.mouthSmoothing??40)/100));
  amplitude=amplitude*sm+energy*(1-sm);
  const threshold=.006+(1-Number(guardConfig.mouthSensitivity??48)/100)*.024;
  if(amplitude*(Number(guardConfig.mouthAmplitude??78)/80)>threshold){
   const seq=[1,2,1,3,1,2,3,1,2,1,3];
   shape=seq[Math.floor((now-spokenAt)/125)%seq.length];
  }
 }
 displayFrame(shape*2+blink);
}
async function initAudio(){
 const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return false;
 if(!audioContext){
  audioContext=new Ctx({sampleRate:24000});
  audioGain=audioContext.createGain();audioGain.gain.value=.95;
  voiceAnalyser=audioContext.createAnalyser();voiceAnalyser.fftSize=1024;
  audioGain.connect(voiceAnalyser);voiceAnalyser.connect(audioContext.destination);
 }
 if(audioContext.state==='suspended')await audioContext.resume().catch(()=>{});
 return audioContext.state==='running';
}
function playLiveAudio(pcm){
 if(!pcm||!guardActive||guardMuted)return;
 let bytes;try{bytes=atob(pcm)}catch{return}
 if(bytes.length<2||bytes.length>1400000)return;
 if(!audioContext){void initAudio();if(!audioContext)return;}
 const samples=new Float32Array(Math.floor(bytes.length/2));
 for(let i=0;i<samples.length;i++){let n=bytes.charCodeAt(2*i)|(bytes.charCodeAt(2*i+1)<<8);if(n&0x8000)n-=0x10000;samples[i]=n/32768;}
 const buffer=audioContext.createBuffer(1,samples.length,24000);buffer.copyToChannel(samples,0);
 const src=audioContext.createBufferSource();src.buffer=buffer;src.connect(audioGain);
 // Igual que NEXO: un pequeño colchón inicial impide que se pierdan
 // las primeras sílabas cuando Android prepara la reproducción del audio.
 const firstChunk=nextAudioTime<=audioContext.currentTime+.01;
 const when=Math.max(nextAudioTime,audioContext.currentTime+(firstChunk?.42:.035));
 nextAudioTime=when+buffer.duration;src.start(when);scheduledSources.add(src);
 src.onended=()=>{scheduledSources.delete(src);try{src.disconnect()}catch{}};
 guardTalking=true;spokenAt=performance.now();
 if(audioContext.state==='suspended'){
  openingPlaybackPending=openingGreeting;
  guardNeedsGesture=true;setMuteAppearance();
  statusText('Soy Erik. Tocame para escuchar mi saludo.');
 }
}
function completedTurn(){
 lastTurnCompleted=true;
 nextCaptionIsNewTurn=true;
 clearTimeout(tailTimer);const epoch=guardEpoch;
 // Si Chrome bloqueó el audio, conservar TODOS los fragmentos del saludo.
 // No habilitar todavía el envío de micrófono: escucharía su propia presentación
 // al tocar para reanudar el audio y podría interrumpirse a sí mismo.
 if(audioContext&&audioContext.state!=='running'){
  openingPlaybackPending=openingGreeting;
  guardNeedsGesture=true;setMuteAppearance();
  statusText('Soy Erik. Tocame para escuchar mi saludo.');
  return;
 }
 const remaining=audioContext?Math.max(0,(nextAudioTime-audioContext.currentTime)*1000+170):100;
 tailTimer=setTimeout(()=>{
  if(epoch!==guardEpoch||guardMuted)return;
  guardTalking=false;amplitude=0;displayFrame(0);
  if(openingGreeting){
   openingGreeting=false;openingPlaybackPending=false;
  }
  if(!outputCaption)statusText('Te escucho.');
 },Math.min(25000,remaining));
}
function appendErikCaption(fragment){
 const incoming=clean(fragment).replace(/\s+/g,' ');
 if(!incoming)return;
 // Se reinicia en cada turno, NO se concatenan respuestas anteriores.
 if(nextCaptionIsNewTurn){
  outputCaption='';nextCaptionIsNewTurn=false;
 }
 if(incoming.startsWith(outputCaption)&&outputCaption)outputCaption=incoming;
 else if(!outputCaption.endsWith(incoming)){
  let overlap=0;
  for(let k=Math.min(outputCaption.length,incoming.length);k>0;k--){
   if(outputCaption.endsWith(incoming.slice(0,k))){overlap=k;break;}
  }
  const tail=incoming.slice(overlap);
  const space=!overlap&&/[\p{L}\p{N}]$/u.test(outputCaption)&&/^[\p{L}\p{N}]/u.test(tail);
  outputCaption+=(space?' ':'')+tail;
 }
 outputCaption=outputCaption.slice(-400);
 // Mostrar únicamente un tramo legible de la intervención actual.
 const words=outputCaption.trim().split(/\s+/u);
 let visible=words.slice(-18).join(' ');
 if(visible.length>135)visible=visible.slice(-135).replace(/^\S*\s/,'');
 // La transcripción puede adelantarse al audio: no mostrarla antes de que suene.
 if(audioContext?.state==='running'&&nextAudioTime>audioContext.currentTime)
  statusText(visible);
}
async function frameImages(list,versions=[]){
 const epoch=++guardFrameLoadEpoch,dock=one('#guard-dock');
 guardFramesFullyReady=false;
 dock?.classList.remove('frames-ready');
 guardVisual.querySelectorAll('.guard-frame').forEach(img=>img.remove());
 guardFrames=Array(8).fill(null);painted=-1;
 const exists=Array.isArray(list)?list:[];
 // Sin PNG no se pinta ningún personaje de ejemplo.
 if(!exists[0])return;
 const load=async i=>{
  if(!exists[i])return null;
  const img=new Image();img.className='guard-frame';img.alt='';img.dataset.frame=String(i);
  img.decoding='async';img.draggable=false;img.src='/api/guard/frames/'+i+'?optimized=1&v='+(versions[i]||0);
  try{await img.decode();return img.complete&&img.naturalWidth?img:null;}catch{return null;}
 };
 const first=load(0),others=Array.from({length:7},(_,j)=>load(j+1));
 const base=await first;
 if(epoch!==guardFrameLoadEpoch||!guardActive)return;
 if(!base){statusText('No se pudo cargar el PNG de Erik. Revisá la imagen en Administración.');return;}
 guardFrames[0]=base;guardVisual.appendChild(base);
 dock?.classList.add('frames-ready');displayFrame(0);
 // Esperar la decodificación de los fotogramas antes de animar.
 const rest=await Promise.all(others);
 if(epoch!==guardFrameLoadEpoch||!guardActive)return;
 rest.forEach((img,j)=>{if(img){guardFrames[j+1]=img;guardVisual.appendChild(img);}});
 guardFramesFullyReady=exists.every((found,i)=>!found||Boolean(guardFrames[i]));
 nextBlink=performance.now()+Math.max(2,Number(guardConfig.blinkRate)||4)*1000;
 displayFrame(0);
}
function noAccents(s){return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
function spokenIntent(heard){
 const original=clean(heard).replace(/^[\s,.;:!?¡¿]+|[\s,.;:!?¡¿]+$/gu,'');
 if(!original)return {type:'unknown'};
 const normalized=noAccents(original).replace(/[.!?]+$/g,'').trim();
 // Comandos deliberados y cortos para poder usarlos también sin lectura.
 if(/^(?:erik[, ]+)?(?:silencio|mute|silenciar|desactivar microfono|terminar llamada)$/.test(normalized))
  return {type:'mute'};
 if(/^(?:erik[, ]+)?(?:para|parate|basta|espera|esperame|callate|deja de hablar|interrumpir)$/.test(normalized)
   || /^(?:para|basta|espera|callate)[, ]+erik$/.test(normalized))
  return {type:'interrupt'};
 if(/^(?:erik[, ]+)?(?:teclado|escribir|quiero escribir)$/.test(normalized))
  return {type:'keyboard'};
 if(/^(?:erik[, ]+)?(?:ayuda|como entro|que hago|no se leer|que contrasena|que clave|cual es (?:la|mi) contrasena|cual es (?:la|mi) clave)$/.test(normalized))
  return {type:'help'};
 if(/^(?:erik[, ]+)?(?:iniciar llamada|empezar llamada|hablar con erik|empezar|escuchame)$/.test(normalized))
  return {type:'listening'};
 if(/^(?:erik[, ]+)?(?:repeti|repite|otra vez)$/.test(normalized))
  return {type:'ask'};
 const single='([\\p{L}\\p{N}_-]+)';
 const key='(?:contrase(?:ñ|n)a|clave)';
 const patterns=[
  new RegExp('^(?:erik[, ]+)?(?:(?:la|mi|tu)\\s+)?'+key+'(?:\\s+(?:es|seria|sería))?\\s*[:, -]+\\s*'+single+'$','iu'),
  new RegExp('^(?:erik[, ]+)?(?:(?:te\\s+)?digo\\s+)?(?:(?:la|mi)\\s+)?'+key+'\\s+(?:es|seria|sería)\\s+'+single+'$','iu'),
  new RegExp('^(?:erik[, ]+)?'+single+'\\s*[,;:-]?\\s+(?:(?:esa|esta|eso|esto)\\s+)?es\\s+(?:(?:la|mi)\\s+)?'+key+'$','iu'),
  new RegExp('^(?:erik[, ]+)?(?:esa|esta)\\s+es\\s+mi\\s+'+key+'\\s*[:, -]+\\s*'+single+'$','iu')
 ];
 for(const pattern of patterns){
  const match=original.match(pattern);
  if(match) {
   // Cada clave expresada oralmente debe ser exactamente UNA palabra.
   const word=match[1];
   // "Esa es la contraseña" o "¿Cuál es la clave?" no aportan una clave.
   if(/^(?:esa|esta|eso|esto|cual|cuál|que|qué|mi|tu|su)$/iu.test(word))
    return {type:'clarify'};
   return {type:'password',value:word.toLocaleLowerCase('es-AR')};
  }
 }
 // Las menciones incompletas de claves NO son contraseñas.
 if(/\b(contrase(?:ñ|n)a|clave|password|pin)\b/iu.test(original))
  return {type:'clarify'};
 // Saludos e interjecciones de una palabra son charla, nunca una clave implícita.
 // Si la contraseña fuera una de ellas, se puede decir "mi contraseña es hola".
 if(/^(?:hola+|buenas|che|ey|epa|eh|gracias|jaja+|jeje+|bueno|dale|ok|okay|si|no|que|quien|como|cuando|donde|mira|quiero|tengo|puedo|podes|sos|estoy|decime|contame|erik)$/i.test(normalized))
  return {type:'conversation',text:original};
 // Solo una palabra COMPLETA, recibida tras la pausa, puede ser una clave.
 if(/^[\p{L}\p{N}_-]+$/u.test(original))
  return {type:'password',value:original.toLocaleLowerCase('es-AR')};
 return {type:'conversation',text:original.slice(0,300)};
}


function appendInput(text){
 if(!guardActive||guardMuted||!micOn)return;
 const s=clean(text).replace(/\s+/g,' ');if(!s)return;
 if(s.startsWith(pendingInput)&&pendingInput)pendingInput=s;
 else if(!pendingInput.endsWith(s)){
  let overlap=0;
  for(let k=Math.min(s.length,pendingInput.length);k>0;k--)if(pendingInput.endsWith(s.slice(0,k))){overlap=k;break;}
  const tail=s.slice(overlap),space=!overlap&&/[\p{L}\p{N}]$/u.test(pendingInput)&&/^[\p{L}\p{N}]/u.test(tail);
  pendingInput+=(space?' ':'')+tail;
 }
 pendingInput=pendingInput.slice(-350);
 clearTimeout(inputTimer);inputTimer=setTimeout(processInput,1000);
}
function processInput(){
 inputTimer=null;const spoken=clean(pendingInput);clearInput();
 if(!spoken||!guardActive||guardMuted||!isLoginVisible())return;
 const intent=spokenIntent(spoken);
 if(intent.type==='password'){
  stopPlayback();const input=one('#password');
  if(input){input.value=intent.value;one('#login-form')?.requestSubmit();}
 }else if(intent.type==='mute'){
  guardMuted=true;pauseMic();stopPlayback();setMuteAppearance();
  statusText('Erik está silenciado. Tocame para continuar.');
 }else if(intent.type==='keyboard')one('#password')?.focus();
 // Conversaciones, bromas e interrupciones ya viajan por audio continuo a Live.
}
function handleLiveMessage(e){
 let m;try{m=JSON.parse(String(e.data))}catch{return}
 if(!guardActive)return;
 if(m.type==='connected'){
  if(m.model!=='gemini-3.8-live'){try{ws?.close()}catch{};return;}
  liveReady=true;connectionRetries=0;openingGreeting=true;openingPlaybackPending=false;nextCaptionIsNewTurn=true;outputCaption='';statusText('Soy Erik.');
  if(pendingIntent){sendIntent(pendingIntent);pendingIntent=null;}
  if(!guardMuted)void startMic();
 }else if(m.type==='audio'){if(!guardMuted)playLiveAudio(m.pcm);}
 else if(m.type==='transcript'){
  if(guardMuted)return;
  appendErikCaption(m.text);
 }else if(m.type==='input_transcript')appendInput(m.text);
 else if(m.type==='turn_complete')completedTurn();
 else if(m.type==='interrupted'){stopPlayback();openingGreeting=false;openingPlaybackPending=false;statusText('Te escucho.');}
 else if(m.type==='notice'){if(!guardTalking)statusText(m.message||'Te escucho.');}
 else if(m.type==='error'||m.type==='closed')statusText('Soy Erik. Tocame para volver a hablar.');
}
function connectLive(){
 if(!guardActive||guardMuted||!isLoginVisible())return;
 if(ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING))return;
 liveReady=false;
 const epoch=guardEpoch,protocol=location.protocol==='https:'?'wss:':'ws:';
 const socket=new WebSocket(protocol+'//'+location.host+'/api/guard/live');ws=socket;
 socket.onmessage=e=>{if(guardEpoch===epoch&&ws===socket)handleLiveMessage(e)};
 socket.onerror=()=>{};
 socket.onclose=()=>{
  if(ws!==socket||guardEpoch!==epoch)return;
  ws=null;liveReady=false;stopPlayback();openingGreeting=true;openingPlaybackPending=false;
  // No cerrar ni volver a abrir el micrófono: reutilizar el stream continuo.
  if(guardActive&&!guardMuted&&isLoginVisible()&&connectionRetries<2){
   connectionRetries++;setTimeout(()=>{if(guardActive&&guardEpoch===epoch&&!guardMuted)connectLive()},1300);
  }else if(guardActive&&!guardMuted)statusText('Soy Erik. Tocame para continuar.');
 };
}
function sendIntent(intent){
 if(!liveReady||!ws||ws.readyState!==WebSocket.OPEN){pendingIntent=intent;connectLive();return;}
 stopPlayback();ws.send(JSON.stringify({type:'intent',intent}));
}
async function toggleGuard(){
 if(!guardActive)return;
 if(guardMuted){
  guardMuted=false;setMuteAppearance();await initAudio();
  if(openingPlaybackPending&&lastTurnCompleted)completedTurn();
  const ok=await startMic(true);
  if(!ok){guardNeedsGesture=true;setMuteAppearance();return;}
  if(!liveReady)connectLive();else sendIntent('ask');
  return;
 }
 if(guardNeedsGesture||!micOn||audioContext?.state!=='running'||micContext?.state!=='running'){
  await initAudio();
  if(openingPlaybackPending&&lastTurnCompleted)completedTurn();
  const ok=await startMic(true);
  if(!ok){statusText('Tocame para habilitar el micrófono.');return;}
  guardNeedsGesture=false;setMuteAppearance();
  if(!liveReady)connectLive();else if(!guardTalking&&!openingGreeting)sendIntent('ask');
  return;
 }
 guardMuted=true;pauseMic();stopPlayback();setMuteAppearance();
 statusText('Erik está silenciado. Tocame para volver a hablar.');
}
async function startGuard(){
 if(guardActive||!isLoginVisible())return;
 guardActive=true;guardMuted=false;guardNeedsGesture=false;connectionRetries=0;openingGreeting=true;openingPlaybackPending=false;nextCaptionIsNewTurn=true;lastTurnCompleted=false;
 const epoch=++guardEpoch;one('#guard-dock')?.classList.remove('hidden');
 nextBlink=performance.now()+3600;
 try{
  const c=await readJSON('/api/guard/config');
  if(!guardActive||epoch!==guardEpoch)return;
  if(!c.enabled){stopGuard({hide:true});return;}
  guardConfig={mouthDelay:c.mouthDelay,mouthSensitivity:c.mouthSensitivity,
   mouthSmoothing:c.mouthSmoothing,mouthAmplitude:c.mouthAmplitude,blinkRate:c.blinkRate};
  void frameImages(c.frames,c.versions);renderGuard();void initAudio();connectLive();
 }catch{statusText('Soy Erik. Podés ingresar por escrito.');}
}
function watchLogin(){
 const root=one('#login-view');if(!root)return;
 const obs=new MutationObserver(()=>{
  if(isLoginVisible()){if(!guardActive)void startGuard();}
  else if(guardActive)stopGuard();
 });
 obs.observe(root,{attributes:true,attributeFilter:['class']});
}
function setupGuardControls(){
 one('#guard-toggle')?.addEventListener('click',()=>void toggleGuard());
 // Escribir contraseña desactiva el envío de audio, sin cerrar el micrófono.
 one('#login-form')?.addEventListener('submit',()=>clearInput(),{capture:true});
 window.addEventListener('nexo-login-error',()=>{
  if(guardActive&&!guardMuted){one('#password')?.blur();sendIntent('retry');}
 });
 window.addEventListener('nexo-login-ok',()=>stopGuard());
 document.addEventListener('visibilitychange',()=>{
  if(!guardActive)return;
  if(!document.hidden&&!guardMuted&&micStream&&!micOn)void startMic();
 });
}
async function makeGuardFrames(list){
 const root=one('#guard-frames-grid');if(!root)return;
 root.replaceChildren();
 const count=(list||[]).filter(Boolean).length;
 one('#guard-frames-count').textContent=count+' / 8 PNG';
 for(let i=0;i<8;i++){
  const card=document.createElement('div');card.className='frame-card';
  const thumb=document.createElement('div');thumb.className='frame-thumb';
  if(list?.[i]){const img=document.createElement('img');img.src='/api/guard/frames/'+i+'?optimized=1&t='+Date.now();img.alt='PNG '+(i+1);thumb.appendChild(img);}
  else{const fallback=document.createElement('span');fallback.className='frame-placeholder';fallback.textContent='✧';thumb.appendChild(fallback);}
  const title=document.createElement('strong');title.textContent=frameDescriptions[i];
  const label=document.createElement('label');label.className='frame-upload';label.textContent=list?.[i]?'Reemplazar PNG':'Subir PNG';
  const input=document.createElement('input');input.type='file';input.accept='image/png';input.setAttribute('aria-label','Subir imagen '+(i+1));
  input.onchange=async()=>{
   const file=input.files?.[0];if(!file)return;
   const fd=new FormData();fd.append('image',file);label.textContent='Subiendo…';
   try{
    await readJSON('/api/admin/guard/frames/'+i,{method:'POST',body:fd});
    const c=await readJSON('/api/guard/config');await makeGuardFrames(c.frames);previewGuard(c.frames);
   }catch(e){label.textContent='Error: '+e.message;}
  };
  label.appendChild(input);card.append(thumb,title,label);root.appendChild(card);
 }
}
function previewGuard(list){
 const im=one('#guard-admin-image');if(!im)return;
 if(list?.[0]){im.src='/api/guard/frames/0?optimized=1&t='+Date.now();im.classList.remove('hidden');}
 else im.classList.add('hidden');
}

function setupAdminGuard(){
 window.addEventListener('nexo-admin-config',()=>{
  void readJSON('/api/guard/config').then(c=>{void makeGuardFrames(c.frames);previewGuard(c.frames);}).catch(()=>{});
 });
 one('#test-guard-voice')?.addEventListener('click',async()=>{
  const btn=one('#test-guard-voice'),out=one('#guard-voice-status');
  btn.disabled=true;out.textContent='Probando voz de Gemini 3.8 Live…';
  try{
   const voice=one('#guard-live-voice')?.value||'Charon';
   const r=await fetch('/api/admin/guard/voice-sample',{
    method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({voice})
   });
   if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||'Error '+r.status);}
   const url=URL.createObjectURL(await r.blob()),a=new Audio(url);
   a.onended=()=>URL.revokeObjectURL(url);
   await a.play();out.textContent='Reproduciendo voz '+voice+'. Guardá para usarla en Erik.';
  }catch(err){out.textContent='No pude probar la voz: '+err.message;}
  finally{btn.disabled=false;}
 });
}

setupGuardControls();setupAdminGuard();watchLogin();
window.addEventListener('pageshow',e=>{if(e.persisted&&isLoginVisible()){if(guardActive)stopGuard();void startGuard()}});
readJSON('/api/me').then(me=>{if(!me.role&&isLoginVisible())void startGuard()}).catch(()=>{if(isLoginVisible())void startGuard()});
