/* Erik: SOLO Gemini 3.8 Live. Independiente del motor de NEXO.
 * Reconocimiento por navegador -> clasificador local -> contraseña o conversación.
 * Jamás enviar contraseñas al Live ni alterar el formulario original.
 */
const one=sel=>document.querySelector(sel);
const clean=value=>String(value||'').normalize('NFC').trim();
const guardVisual=one('#guard-avatar'),status=one('#guard-status');
const frameDescriptions=['Abiertos · reposo','Cerrados · reposo','Abiertos · A','Cerrados · A','Abiertos · O','Cerrados · O','Abiertos · E','Cerrados · E'];
let guardConfig={},guardFrames=[],guardFramesFullyReady=false,guardFrameLoadEpoch=0;
let guardActive=false,guardMuted=false,guardNeedsGesture=false,guardEpoch=0,guardTalking=false;
let painted=-1,rAF=0,nextBlink=0,blinkEnd=0,amplitude=0,spokenAt=0;
let ws=null,liveReady=false,pendingIntent=null,connectionRetries=0;
let recognizer=null,recognizing=false,recognitionWanted=false,recognitionRestartTimer=null,recognitionErrors=0;
let audioContext=null,audioGain=null,voiceAnalyser=null,nextAudioTime=0,outputCaption='',turnComplete=false;
let scheduledSources=new Set(),audioGeneration=0,tailTimer=null;
const statusText=text=>{if(status)status.textContent=String(text||'');};
const isLoginVisible=()=>!one('#login-view')?.classList.contains('hidden');
async function readJSON(url,opt={}){
 const r=await fetch(url,{credentials:'same-origin',...opt});
 const data=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(data.error||'Error '+r.status);
 return data;
}
function setMuteAppearance(){
 const button=one('#guard-toggle'),dock=one('#guard-dock');
 dock?.classList.toggle('is-muted',guardMuted);
 button?.setAttribute('aria-pressed',String(guardMuted));
 const label=guardMuted?'Volver a hablar con Erik':guardNeedsGesture?'Activar el sonido de Erik y el micrófono':'Silenciar a Erik y el micrófono';
 button?.setAttribute('aria-label',label);button?.setAttribute('title',label);
 const hint=one('#guard-hint');if(hint)hint.textContent=label;
}
function stopRecognition(){
 recognitionWanted=false;recognizing=false;
 clearTimeout(recognitionRestartTimer);recognitionRestartTimer=null;
 try{recognizer?.abort();}catch{}
}
function canListen(){
 return guardActive&&!guardMuted&&liveReady&&!guardTalking&&!guardNeedsGesture&&!document.hidden
  &&isLoginVisible()&&document.activeElement!==one('#password');
}
function queueRecognitionRestart(ms=350){
 clearTimeout(recognitionRestartTimer);
 if(!recognitionWanted||!canListen())return;
 recognitionRestartTimer=setTimeout(()=>{recognitionRestartTimer=null;if(recognitionWanted&&canListen())listen();},ms);
}
function stopPlayback(){
 audioGeneration++;clearTimeout(tailTimer);tailTimer=null;
 for(const src of scheduledSources){try{src.stop();src.disconnect();}catch{}}
 scheduledSources.clear();nextAudioTime=0;turnComplete=false;outputCaption='';
 guardTalking=false;amplitude=0;displayFrame(0);
}
function stopGuard({hide=false}={}){
 guardEpoch++;stopRecognition();stopPlayback();guardActive=false;guardMuted=false;
 liveReady=false;pendingIntent=null;guardNeedsGesture=false;
 if(ws){const old=ws;ws=null;try{old.close(1000,'Dejando el ingreso')}catch{}}
 if(rAF)cancelAnimationFrame(rAF);rAF=0;painted=-1;
 if(hide)one('#guard-dock')?.classList.add('hidden');
 setMuteAppearance();
}
function displayFrame(index){
 const f=(guardFramesFullyReady?guardFrames[index]:null)||guardFrames[0];
 if(!f||!f.complete||!f.naturalWidth)return;
 const next=Number(f.dataset.frame);
 if(next===painted)return;
 painted=next;guardFrames.forEach(x=>x?.classList.toggle('is-visible',x===f));
 one('#guard-fallback')?.classList.add('hidden');
}
function renderGuard(){
 if(!guardActive||!isLoginVisible()){rAF=0;return;}
 rAF=requestAnimationFrame(renderGuard);
 const now=performance.now();
 if(now>nextBlink){blinkEnd=now+130;nextBlink=now+Math.max(2,Number(guardConfig.blinkRate)||4)*1000+Math.random()*900;}
 const blink=now<blinkEnd?1:0;
 let shape=0;
 if(!guardMuted&&guardTalking&&audioContext?.state==='running'&&audioContext.currentTime<nextAudioTime+.04){
  let energy=.05;
  if(voiceAnalyser){
   const sample=new Float32Array(voiceAnalyser.fftSize);
   voiceAnalyser.getFloatTimeDomainData(sample);
   let sum=0;for(let i=0;i<sample.length;i+=4)sum+=sample[i]*sample[i];
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
 if(!('AudioContext' in window||'webkitAudioContext' in window))throw new Error('Este navegador no tiene salida de audio compatible');
 const Ctx=window.AudioContext||window.webkitAudioContext;
 if(!audioContext){
  audioContext=new Ctx({sampleRate:24000});
  audioGain=audioContext.createGain();audioGain.gain.value=.95;
  voiceAnalyser=audioContext.createAnalyser();voiceAnalyser.fftSize=1024;
  audioGain.connect(voiceAnalyser);voiceAnalyser.connect(audioContext.destination);
 }
 if(audioContext.state==='suspended')await audioContext.resume().catch(()=>{});
 guardNeedsGesture=audioContext.state!=='running';
 setMuteAppearance();
 return !guardNeedsGesture;
}
function playLiveAudio(pcm){
 if(!pcm||!guardActive||guardMuted)return;
 let bytes;try{bytes=atob(pcm);}catch{return;}
 if(bytes.length<2||bytes.length>1400000)return;
 if(!audioContext){void initAudio().catch(()=>{});return;}
 const samples=new Float32Array(Math.floor(bytes.length/2));
 for(let i=0;i<samples.length;i++){
  let n=bytes.charCodeAt(i*2)|(bytes.charCodeAt(i*2+1)<<8);
  if(n&0x8000)n-=0x10000;samples[i]=n/32768;
 }
 const buffer=audioContext.createBuffer(1,samples.length,24000);
 buffer.copyToChannel(samples,0);
 const src=audioContext.createBufferSource();src.buffer=buffer;src.connect(audioGain);
 const when=Math.max(nextAudioTime,audioContext.currentTime+.045);
 nextAudioTime=when+buffer.duration;
 src.start(when);scheduledSources.add(src);
 src.onended=()=>{scheduledSources.delete(src);try{src.disconnect()}catch{}};
 guardTalking=true;spokenAt=performance.now();turnComplete=false;
 if(audioContext.state!=='running'){
  guardNeedsGesture=true;setMuteAppearance();
  statusText('Soy Erik. Tocame para activar el sonido de Gemini Live.');
 }
}
function completedTurn(){
 turnComplete=true;
 clearTimeout(tailTimer);
 if(audioContext?.state==='suspended'){
  guardNeedsGesture=true;setMuteAppearance();
  statusText('Soy Erik. Tocame para escucharme con la voz de Gemini Live.');
  return;
 }
 const epoch=guardEpoch,remaining=audioContext?Math.max(0,(nextAudioTime-audioContext.currentTime)*1000+120):100;
 tailTimer=setTimeout(()=>{
  if(epoch!==guardEpoch||guardMuted)return;
  guardTalking=false;amplitude=0;displayFrame(0);
  if(guardActive)listen();
 },Math.min(25000,remaining));
}
function handleLiveMessage(e){
 let m;try{m=JSON.parse(String(e.data));}catch{return;}
 if(!guardActive||guardMuted)return;
 if(m.type==='connected'){
  if(m.model!=='gemini-3.8-live'){statusText('Se recibió un modelo incorrecto.');try{ws?.close()}catch{};return;}
  liveReady=true;connectionRetries=0;statusText('Erik se está presentando…');
  if(pendingIntent){sendIntent(pendingIntent);pendingIntent=null;}
 }else if(m.type==='audio'){playLiveAudio(m.pcm);}
 else if(m.type==='transcript'){
  const t=String(m.text||'').replace(/\s+/g,' ').trim();
  if(t){
   if(t.startsWith(outputCaption)&&outputCaption)outputCaption=t;
   else if(!outputCaption.endsWith(t))outputCaption+=(outputCaption?' ':'')+t;
   if(!guardNeedsGesture)statusText(outputCaption.slice(-550));
  }
 }else if(m.type==='turn_complete')completedTurn();
 else if(m.type==='interrupted'){stopPlayback();listen();}
 else if(m.type==='notice'){statusText(m.message||'Te escucho.');listen();}
 else if(m.type==='error'||m.type==='closed'){
  statusText(String(m.message||'Gemini Live no está disponible.').slice(0,220));
  guardTalking=false;listen();
 }
}
function connectLive(){
 if(!guardActive||guardMuted||!isLoginVisible())return;
 if(ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING))return;
 liveReady=false;
 const epoch=guardEpoch;
 const protocol=location.protocol==='https:'?'wss:':'ws:';
 const socket=new WebSocket(protocol+'//'+location.host+'/api/guard/live');
 ws=socket;statusText('Conectando con Erik · Gemini 3.8 Live…');
 socket.onmessage=e=>{if(guardEpoch===epoch&&ws===socket)handleLiveMessage(e);};
 socket.onerror=()=>{if(guardEpoch===epoch)statusText('No pude conectar con Erik. Tocame para reintentar.')};
 socket.onclose=()=>{
  if(ws!==socket||guardEpoch!==epoch)return;
  ws=null;liveReady=false;stopRecognition();stopPlayback();
  if(guardActive&&!guardMuted&&isLoginVisible()&&connectionRetries<1){
   connectionRetries++;setTimeout(()=>{if(guardActive&&guardEpoch===epoch&&!guardMuted)connectLive();},1500);
  }else if(guardActive&&!guardMuted){guardNeedsGesture=true;setMuteAppearance();statusText('Gemini 3.8 Live se desconectó. Tocame para volver a llamar a Erik.');}
 };
}
function sendIntent(intent){
 if(!liveReady||!ws||ws.readyState!==WebSocket.OPEN){pendingIntent=intent;connectLive();return;}
 stopRecognition();stopPlayback();guardTalking=true;
 statusText('Erik está respondiendo…');
 ws.send(JSON.stringify({type:'intent',intent}));
}
function sendConversation(text){
 if(!liveReady||!ws||ws.readyState!==WebSocket.OPEN){statusText('Erik todavía está conectando.');return;}
 stopRecognition();stopPlayback();guardTalking=true;
 statusText('Vos: '+String(text).slice(0,180));
 ws.send(JSON.stringify({type:'text',text:String(text).slice(0,300)}));
}
async function toggleGuard(){
 if(!guardActive)return;
 if(guardNeedsGesture&&!guardMuted){
  const sound=await initAudio().catch(()=>false);
  if(!sound){statusText('Chrome bloqueó el audio. Tocá de nuevo para activarlo.');return;}
  guardNeedsGesture=false;setMuteAppearance();
  if(!liveReady){connectionRetries=0;connectLive();}
  else if(!guardTalking||nextAudioTime<=audioContext.currentTime){
   ws?.send(JSON.stringify({type:'repeat'}));guardTalking=true;statusText('Erik está saludando…');
  }else if(turnComplete)completedTurn();
  return;
 }
 guardMuted=!guardMuted;stopRecognition();stopPlayback();
 setMuteAppearance();
 if(guardMuted){statusText('Erik está silenciado. Tocame para continuar.');return;}
 connectionRetries=0;
 // Si estaba conectado, retomar la misma sesión; si no, abrir una nueva.
 if(liveReady){sendIntent('ask');}else connectLive();
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
 if(/^(?:erik[, ]+)?(?:colgar|cancelar|para|terminar llamada|silencio|mute|silenciar)$/.test(normalized))
  return {type:'mute'};
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
 // Clave en solitario: NUNCA enviar una sola palabra a Gemini.
 if(/^[\p{L}\p{N}_-]+$/u.test(original))
  return {type:'password',value:original.toLocaleLowerCase('es-AR')};
 // Si contiene términos de contraseña pero no fue una asignación inequívoca,
 // pedir aclaración sin enviar el posible secreto al proveedor de IA.
 if(/\b(contrase(?:ñ|n)a|clave|password|pin)\b/iu.test(original))
  return {type:'clarify'};
 return {type:'conversation',text:original.slice(0,300)};
}

async function handleVoice(heard){
 if(!guardActive||guardMuted||!isLoginVisible())return;
 const intent=spokenIntent(heard);
 if(intent.type==='mute'){guardMuted=true;stopRecognition();stopPlayback();setMuteAppearance();statusText('Erik silenciado. Tocame para reactivar.');return;}
 if(intent.type==='keyboard'){one('#password')?.focus();statusText('Podés escribir tu contraseña.');return;}
 if(['help','listening','ask','clarify'].includes(intent.type)){sendIntent(intent.type);return;}
 if(intent.type==='conversation'){sendConversation(intent.text);return;}
 if(intent.type!=='password'){listen();return;}
 // La clave solo viaja a /api/login: nunca al WebSocket de Gemini Live.
 stopRecognition();stopPlayback();statusText('Comprobando contraseña…');
 const input=one('#password');
 if(input){input.value=intent.value;one('#login-form')?.requestSubmit();}
}
function getRecognizer(){
 if(recognizer)return recognizer;
 const API=window.SpeechRecognition||window.webkitSpeechRecognition;
 if(!API)return null;
 const r=new API();r.lang='es-AR';r.continuous=false;r.interimResults=false;r.maxAlternatives=1;
 r.onstart=()=>{recognizing=true;recognitionErrors=0;statusText('Te escucho. Decí una sola palabra para ingresar o hablame en una frase.');};
 r.onerror=e=>{
  recognizing=false;
  if(!recognitionWanted||!guardActive||guardMuted||e.error==='aborted')return;
  if(e.error==='not-allowed'||e.error==='service-not-allowed'){
   guardNeedsGesture=true;recognitionWanted=false;setMuteAppearance();
   statusText('Permití el micrófono para hablar o ingresá por teclado.');
  }else if(e.error!=='no-speech'){
   recognitionErrors++;queueRecognitionRestart(500);
  }
 };
 r.onend=()=>{recognizing=false;if(recognitionWanted&&canListen())queueRecognitionRestart(300);};
 r.onresult=e=>{
  if(!recognitionWanted||!canListen())return;
  const word=clean(e.results?.[e.resultIndex]?.[0]?.transcript);
  if(!word)return;
  stopRecognition();
  void handleVoice(word);
 };
 recognizer=r;return r;
}
function listen(){
 if(!canListen()||recognizing)return;
 const r=getRecognizer();
 if(!r){statusText('Este navegador no admite dictado. Podés escribir la contraseña.');return;}
 recognitionWanted=true;
 try{r.start();}catch(err){
  if(err.name==='InvalidStateError'){queueRecognitionRestart(500);return;}
  if(err.name==='NotAllowedError'){guardNeedsGesture=true;setMuteAppearance();return;}
  queueRecognitionRestart(800);
 }
}
async function startGuard(){
 if(guardActive||!isLoginVisible())return;
 guardActive=true;guardMuted=false;guardNeedsGesture=false;connectionRetries=0;
 const epoch=++guardEpoch;
 one('#guard-dock')?.classList.remove('hidden');
 nextBlink=performance.now()+3600;
 try{
  const c=await readJSON('/api/guard/config');
  if(!guardActive||epoch!==guardEpoch)return;
  if(!c.enabled){stopGuard({hide:true});return;}
  guardConfig={mouthDelay:c.mouthDelay,mouthSensitivity:c.mouthSensitivity,
   mouthSmoothing:c.mouthSmoothing,mouthAmplitude:c.mouthAmplitude,blinkRate:c.blinkRate};
  void frameImages(c.frames,c.versions);
  renderGuard();
  void initAudio().catch(()=>{});
  connectLive();
 }catch{statusText('Erik no pudo iniciar. Podés ingresar por escrito.');}
}
function watchLogin(){
 const root=one('#login-view');if(!root)return;
 const observer=new MutationObserver(()=>{
  if(isLoginVisible()){if(!guardActive)void startGuard();}
  else if(guardActive)stopGuard();
 });
 observer.observe(root,{attributes:true,attributeFilter:['class']});
}
function setupGuardControls(){
 one('#guard-toggle')?.addEventListener('click',()=>void toggleGuard());
 one('#password')?.addEventListener('focus',()=>{
  if(guardActive&&!guardMuted){stopRecognition();stopPlayback();statusText('Escribí la contraseña.');}
 });
 one('#password')?.addEventListener('blur',()=>{if(guardActive&&!guardMuted&&!guardTalking)listen();});
 one('#login-form')?.addEventListener('submit',()=>stopRecognition(),{capture:true});
 window.addEventListener('nexo-login-error',()=>{
  if(guardActive&&!guardMuted){one('#password')?.blur();sendIntent('retry');}
 });
 window.addEventListener('nexo-login-ok',()=>stopGuard());
 document.addEventListener('visibilitychange',()=>{
  if(!guardActive)return;
  if(document.hidden){stopRecognition();}
  else if(!guardMuted&&!guardTalking&&!guardNeedsGesture)listen();
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
window.addEventListener('pageshow',event=>{if(event.persisted&&isLoginVisible()){if(guardActive)stopGuard();void startGuard();}});
readJSON('/api/me').then(me=>{if(!me.role&&isLoginVisible())void startGuard();}).catch(()=>{if(isLoginVisible())void startGuard();});
