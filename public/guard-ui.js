/* Erik: portero de NEXOCV. La verificación de contraseñas se hace SOLO en /api/login. */
const one=(s)=>document.querySelector(s);
let guardConfig={}, guardFrames=[], guardActive=false,guardEpoch=0,guardMuted=false,guardNeedsGesture=false;
let recognizer=null,recognizing=false,recognitionWanted=false,guardTalking=false,recognitionRestartTimer=null,recognitionErrors=0;
let guardFramesFullyReady=false,guardFrameLoadEpoch=0,guardSpeechTurn=0;
let voicePlayer=null,voiceContext=null,voiceAnalyser=null,voiceSource=null,speechWait=null,voiceFinish=null,browserVoiceFinish=null;
let rAF=0,nextBlink=0,blinkEnd=0,painted=-1,amplitude=0,spokenAt=0,voiceGreeting=false;
const guardVisual=one('#guard-avatar'),status=one('#guard-status');
const frameDescriptions=['Abiertos · reposo','Cerrados · reposo','Abiertos · A','Cerrados · A','Abiertos · O','Cerrados · O','Abiertos · E','Cerrados · E'];
const clean=(s)=>String(s||'').normalize('NFC').trim();
function statusText(t){if(status)status.textContent=t;}
function isLoginVisible(){return !one('#login-view')?.classList.contains('hidden');}
async function readJSON(url,opt){const r=await fetch(url,{credentials:'same-origin',...opt});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Error '+r.status);return data;}
function stopRecognition(){
 recognitionWanted=false;recognizing=false;
 clearTimeout(recognitionRestartTimer);recognitionRestartTimer=null;
 if(recognizer){try{recognizer.abort();}catch{}}
}
function canListen(){return guardActive&&!guardMuted&&isLoginVisible()&&!guardTalking&&!document.hidden&&document.activeElement!==one('#password');}
function queueRecognitionRestart(delay=400){
 clearTimeout(recognitionRestartTimer);
 if(!recognitionWanted||!canListen())return;
 recognitionRestartTimer=setTimeout(()=>{recognitionRestartTimer=null;if(recognitionWanted&&canListen())listen();},delay);
}
function stopAudio(){
 guardSpeechTurn++;
 if(voicePlayer){voicePlayer.pause();voicePlayer.removeAttribute('src');voicePlayer.load();voicePlayer=null;}
 try{speechSynthesis.cancel();}catch{}
 voiceFinish?.();browserVoiceFinish?.();
 voiceFinish=null;browserVoiceFinish=null;
 guardTalking=false;voiceGreeting=false;
}
function setMuteAppearance(){
 const button=one('#guard-toggle'),dock=one('#guard-dock');
 dock?.classList.toggle('is-muted',guardMuted);
 button?.setAttribute('aria-pressed',String(guardMuted));
 const label=guardMuted?'Reactivar voz y micrófono de Erik':guardNeedsGesture?'Activar voz y micrófono de Erik':'Silenciar a Erik y detener el micrófono';
 button?.setAttribute('aria-label',label);button?.setAttribute('title',label);
 const hint=one('#guard-hint');if(hint)hint.textContent=label;
}
function stopGuard({hide=false}={}){
 guardEpoch++;guardFrameLoadEpoch++;stopRecognition();stopAudio();guardActive=false;guardMuted=false;guardNeedsGesture=false;
 if(rAF)cancelAnimationFrame(rAF);rAF=0;painted=-1;setMuteAppearance();
 if(hide)one('#guard-dock')?.classList.add('hidden');
}
function toggleGuard(){
 if(!guardActive)return;
 // Si el navegador bloqueó el inicio automático, el primer toque sirve para activar.
 if(guardNeedsGesture&&!guardMuted){
  guardEpoch++;guardNeedsGesture=false;stopRecognition();stopAudio();setMuteAppearance();
  void audioUnlock();void say('ask');return;
 }
 guardMuted=!guardMuted;guardEpoch++;guardNeedsGesture=false;
 stopRecognition();stopAudio();amplitude=0;displayFrame(0);setMuteAppearance();
 if(guardMuted){statusText('Está bien, me callo. Tocame para volver a hablar.');return;}
 statusText('Dale, sigo acá. ¿Cuál es la contraseña?');
 void audioUnlock();void say('ask');
}
function displayFrame(i){
 const frame=(guardFramesFullyReady?guardFrames[i]:null)||guardFrames[0];
 if(!frame||!frame.complete||!frame.naturalWidth)return;
 const target=Number(frame.dataset.frame);
 if(target===painted)return;
 painted=target;
 guardFrames.forEach(x=>x?.classList.toggle('is-visible',x===frame));
 one('#guard-fallback')?.classList.add('hidden');
}
function renderGuard(){
 if(!guardActive||!isLoginVisible()){rAF=0;return;}
 rAF=requestAnimationFrame(renderGuard);
 const now=performance.now();
 if(now>nextBlink){blinkEnd=now+130;nextBlink=now+Math.max(2,Number(guardConfig.blinkRate)||4)*1000+Math.random()*900;}
 const blink=now<blinkEnd?1:0;
 let shape=0;
 if(!guardMuted&&guardTalking&&now-spokenAt>Number(guardConfig.mouthDelay||0)){
  let energy=.045;
  if(voiceAnalyser&&voiceContext&&voiceContext.state==='running'&&voicePlayer&&!voicePlayer.paused){
   const data=new Float32Array(voiceAnalyser.fftSize);voiceAnalyser.getFloatTimeDomainData(data);
   let sum=0;for(let i=0;i<data.length;i+=4)sum+=data[i]*data[i];
   energy=Math.sqrt(sum/Math.max(1,data.length/4));
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
async function audioUnlock(){
 const AC=window.AudioContext||window.webkitAudioContext;
 if(!AC)return;
 try{
  voiceContext||=new AC();
  if(voiceContext.state==='suspended')await voiceContext.resume();
 }catch{}
}
function speakBrowser(text){
 return new Promise(resolve=>{
  if(!('speechSynthesis' in window)){guardNeedsGesture=true;setMuteAppearance();resolve();return;}
  let done=false;const end=()=>{if(done)return;done=true;clearTimeout(timeout);if(browserVoiceFinish===end)browserVoiceFinish=null;resolve();};
  const u=new SpeechSynthesisUtterance(text);u.lang='es-AR';u.rate=.96;u.pitch=.95;
  let started=false;browserVoiceFinish=end;
  u.onstart=()=>{started=true;guardNeedsGesture=false;setMuteAppearance();};
  u.onend=end;
  u.onerror=()=>{if(!started){guardNeedsGesture=true;setMuteAppearance();}end();};
  const timeout=setTimeout(()=>{if(!started){guardNeedsGesture=true;setMuteAppearance();}end();},Math.max(3000,Math.min(17000,text.length*115)));
  try{speechSynthesis.cancel();speechSynthesis.speak(u);}catch{guardNeedsGesture=true;setMuteAppearance();end();}
 });
}
async function playFish(b64,mime){
 const binary=atob(b64),bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 const url=URL.createObjectURL(new Blob([bytes],{type:mime||'audio/mpeg'}));
 const audio=new Audio(url),token=guardEpoch;voicePlayer=audio;
 try{
  if(voiceContext){
   try{
    voiceAnalyser=voiceContext.createAnalyser();voiceAnalyser.fftSize=1024;
    voiceSource=voiceContext.createMediaElementSource(audio);voiceSource.connect(voiceAnalyser);voiceAnalyser.connect(voiceContext.destination);
   }catch(e){console.warn('Erik: sin analizador:',e);}
  }
  try{await audio.play();}catch(e){guardNeedsGesture=true;setMuteAppearance();throw e;}
  guardNeedsGesture=false;setMuteAppearance();
  await new Promise(resolve=>{const finish=()=>{if(voiceFinish===finish)voiceFinish=null;resolve();};voiceFinish=finish;audio.onended=finish;audio.onerror=finish;});
 }finally{
  URL.revokeObjectURL(url);
  if(token===guardEpoch)voicePlayer=null;
  try{voiceSource?.disconnect();voiceAnalyser?.disconnect();}catch{}
  voiceSource=null;voiceAnalyser=null;
 }
}
async function say(intent,{resumeListening=true}={}){
 if(!guardActive||guardMuted||!isLoginVisible())return;
 stopRecognition();stopAudio();
 const token=guardEpoch;
 const speechTurn=guardSpeechTurn;
 guardTalking=false;statusText('Erik está preparando su respuesta…');
 try{
  const data=await readJSON('/api/guard/line',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({intent})});
  if(!guardActive||guardMuted||guardEpoch!==token||guardSpeechTurn!==speechTurn)return;
  statusText(data.text||'');
  guardTalking=true;spokenAt=performance.now();amplitude=0;
  if(data.engine==='fish'&&data.audio){
   try{await playFish(data.audio,data.mime);}catch(e){
    statusText('Tu navegador bloqueó el sonido. Tocá a Erik para activarlo.');
    console.warn('Audio bloqueado por navegador:',e);
   }
  }else await speakBrowser(data.text);
 }catch(e){statusText('Erik: '+e.message);}
 finally{
  if(guardEpoch===token&&guardSpeechTurn===speechTurn&&!guardMuted){guardTalking=false;amplitude=0;displayFrame(0);if(resumeListening&&guardActive)listen();}
 }
}
// Escucha persistente: Chrome puede finalizar sesiones de reconocimiento aunque
// continuous=true. Cada cierre natural vuelve a iniciar sin exigir tocar un botón.
function getRecognizer(){
 if(recognizer)return recognizer;
 const API=window.SpeechRecognition||window.webkitSpeechRecognition;
 if(!API)return null;
 const r=new API();
 r.lang='es-AR';r.continuous=true;r.interimResults=false;r.maxAlternatives=1;
 r.onstart=()=>{
  if(!recognitionWanted||!canListen()){try{r.abort();}catch{}return;}
  recognizing=true;recognitionErrors=0;
  statusText('Te escucho. Decime la contraseña.');
 };
 r.onerror=e=>{
  recognizing=false;
  if(!guardActive||guardMuted||!recognitionWanted||e.error==='aborted')return;
  if(e.error==='not-allowed'||e.error==='service-not-allowed'||e.error==='audio-capture'){
   recognitionWanted=false;guardNeedsGesture=true;setMuteAppearance();
   statusText('Micrófono sin permiso. Tocá a Erik para activarlo o ingresá por escrito.');
   return;
  }
  if(e.error==='no-speech'){
   // Normal en personas que necesitan más tiempo para responder: seguir escuchando.
   statusText('Sigo escuchando. Podés hablar cuando quieras.');
  }else{
   recognitionErrors++;
   statusText('Sigo acá. Recuperando la escucha…');
  }
 };
 r.onend=()=>{
  recognizing=false;
  if(recognitionWanted&&canListen()){
   queueRecognitionRestart(recognitionErrors?Math.min(5000,500*Math.pow(1.6,Math.min(recognitionErrors,5))):300);
  }
 };
 r.onresult=e=>{
  if(!recognitionWanted||!canListen())return;
  const value=clean(e.results?.[e.resultIndex]?.[0]?.transcript);
  if(!value)return;
  // Pausar solamente para interpretar la frase o responder, sin cerrar el "modo llamada".
  recognitionWanted=false;clearTimeout(recognitionRestartTimer);
  try{r.abort();}catch{}
  recognizing=false;
  void handleVoice(value);
 };
 recognizer=r;return r;
}
function listen(){
 if(!canListen()||recognizing)return;
 const r=getRecognizer();
 if(!r){statusText('Este navegador no admite dictado. Podés escribir la contraseña.');return;}
 recognitionWanted=true;
 try{r.start();}
 catch(e){
  if(e?.name==='InvalidStateError'){queueRecognitionRestart(650);return;}
  recognitionErrors++;
  if(e?.name==='NotAllowedError'||e?.name==='SecurityError'){
   recognitionWanted=false;guardNeedsGesture=true;setMuteAppearance();
   statusText('Para hablar con Erik, permití el micrófono en tu navegador.');
  }else{queueRecognitionRestart(Math.min(4000,500*recognitionErrors));}
 }
}
document.addEventListener('visibilitychange',()=>{
 if(!guardActive||guardMuted)return;
 if(document.hidden){
  clearTimeout(recognitionRestartTimer);recognitionRestartTimer=null;
  try{recognizer?.abort();}catch{}
  recognizing=false;
 }else if(!guardTalking&&document.activeElement!==one('#password')){
  // El navegador puede suspender el micrófono en segundo plano; retomarlo al volver.
  recognitionWanted=true;queueRecognitionRestart(500);
 }
});
function noAccents(s){return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
async function handleVoice(heard){
 if(!guardActive||guardMuted||!isLoginVisible())return;
 const command=noAccents(heard).replace(/[.!?]+$/g,'').trim();
 if(/^(?:erik[, ]+)?(?:iniciar llamada|empezar llamada|hablar con erik|empezar|escuchame)$/.test(command)){void say('listening');return;}
 if(/^(?:erik[, ]+)?(?:ayuda|como entro|que hago|no se leer|que contrasena|que clave)$/.test(command)){void say('help');return;}
 if(/^(?:erik[, ]+)?(?:repeti|repite|otra vez)$/.test(command)){void say('ask');return;}
 if(/^(?:erik[, ]+)?(?:colgar|cancelar|para|terminar llamada|silencio|mute|silenciar)$/.test(command)){guardMuted=true;guardEpoch++;stopRecognition();stopAudio();displayFrame(0);setMuteAppearance();statusText('Silenciado. Tocame para reactivar voz y micrófono.');return;}
 if(/^(?:erik[, ]+)?(?:teclado|escribir|quiero escribir)$/.test(command)){one('#password')?.focus();statusText('Escribí tu contraseña en el campo.');return;}
 // Nunca mostrar, registrar en consola ni enviar a Gemini o Fish la clave reconocida.
 const secret=heard.replace(/^(?:erik[\s,]+)?(?:(?:mi|la)\s+)?(?:contrase(?:ñ|n)a|clave)(?:\s+(?:es|seria))?\s*[:,-]?\s*/iu,'').trim();
 if(!secret){void say('ask');return;}
 statusText('Verificando contraseña…');
 stopRecognition();stopAudio();displayFrame(0);
 const input=one('#password');
 if(!input)return;
 input.value=secret;
 one('#login-form')?.requestSubmit();
}
async function startGuard(){
 if(guardActive||!isLoginVisible())return;
 guardActive=true;guardMuted=false;guardNeedsGesture=false;setMuteAppearance();const token=++guardEpoch;
 one('#guard-dock')?.classList.remove('hidden');
 nextBlink=performance.now()+3800;
 try{
  const c=await readJSON('/api/guard/config');if(!guardActive||guardEpoch!==token)return;
  if(!c.enabled){stopGuard({hide:true});return;}
  guardConfig={mouthDelay:c.mouthDelay,mouthSensitivity:c.mouthSensitivity,mouthSmoothing:c.mouthSmoothing,mouthAmplitude:c.mouthAmplitude,blinkRate:c.blinkRate};
  void frameImages(c.frames,c.versions);
  renderGuard();
  await say('greeting');
 }catch(e){statusText('Erik no se pudo conectar. El ingreso por contraseña sigue disponible.');}
}
function watchLogin(){
 const root=one('#login-view');if(!root)return;
 const mo=new MutationObserver(()=>{
  if(isLoginVisible()){if(!guardActive)void startGuard();}
  else if(guardActive)stopGuard();
 });
 mo.observe(root,{attributes:true,attributeFilter:['class']});
}
function setupGuardControls(){
 one('#guard-toggle')?.addEventListener('click',toggleGuard);
 // Cuando alguien elige escribir, no escuchar accidentalmente lo que pasa alrededor.
 one('#password')?.addEventListener('focus',()=>{
  if(guardActive&&!guardMuted){guardEpoch++;stopRecognition();stopAudio();displayFrame(0);statusText('Perfecto, escribí tu contraseña.');}
 });
 one('#password')?.addEventListener('blur',()=>{
  if(guardActive&&!guardMuted&&isLoginVisible())listen();
 });
 // El formulario original siempre funciona, independientemente de Erik.
 one('#login-form')?.addEventListener('submit',()=>{stopRecognition();stopAudio();},{capture:true});
 window.addEventListener('nexo-login-error',()=>{if(guardActive&&!guardMuted)void say('retry');});
 window.addEventListener('nexo-login-ok',()=>{stopGuard();});
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
 window.addEventListener('nexo-admin-config',e=>{
  const data=e.detail||{};void makeGuardFrames((data.guardFrames||[]));
  const fishReady=data.fishReady;
  if(!fishReady)one('#guard-voice-status').textContent='Falta FISH_API_KEY en Railway. Hasta configurarla, Erik usa la voz del navegador.';
  void readJSON('/api/guard/config').then(c=>{makeGuardFrames(c.frames);previewGuard(c.frames)}).catch(()=>{});
  void readJSON('/api/admin/guard/voice-reference').then(info=>{const st=one('#guard-reference-status'),tx=one('#guard-reference-text');if(info.exists){st.textContent='Muestra guardada: '+info.name;if(tx)tx.value=info.text||'';}else st.textContent='Todavía no cargaste ninguna muestra de audio.';}).catch(()=>{});
 });
 one('#save-guard-reference')?.addEventListener('click',async()=>{
  const btn=one('#save-guard-reference'),result=one('#guard-reference-status');
  const file=one('#guard-reference-audio')?.files?.[0],transcript=one('#guard-reference-text')?.value?.trim();
  if(!file||!transcript){result.textContent='Seleccioná el audio y escribí exactamente lo que dice.';return;}
  btn.disabled=true;result.textContent='Guardando audio en Railway…';
  const fd=new FormData();fd.append('audio',file);fd.append('text',transcript);
  try{const data=await readJSON('/api/admin/guard/voice-reference',{method:'POST',body:fd});result.textContent='Muestra guardada: '+data.name+'. Dejá el ID de voz vacío para usar esta grabación.';}
  catch(e){result.textContent='No se pudo guardar: '+e.message;}
  finally{btn.disabled=false;}
 });
 one('#test-guard-voice')?.addEventListener('click',async()=>{
  const btn=one('#test-guard-voice'),out=one('#guard-voice-status');
  btn.disabled=true;out.textContent='Solicitando la muestra a Fish Audio…';
  const val=k=>one('[data-setting="'+k+'"]')?.value;
  try{
   const r=await fetch('/api/admin/guard/voice-sample',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:val('guardSampleText'),voiceId:val('guardVoiceId'),model:val('guardFishModel'),temperature:Number(val('guardTemperature')),topP:Number(val('guardTopP')),speed:Number(val('guardSpeed'))})});
   if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||'Error '+r.status);}
   const url=URL.createObjectURL(await r.blob()),a=new Audio(url);
   a.onended=()=>URL.revokeObjectURL(url);await a.play();out.textContent='Reproduciendo voz Fish Audio.';
  }catch(e){out.textContent='Muestra no disponible: '+e.message;}
  finally{btn.disabled=false;}
 });
}
setupGuardControls();setupAdminGuard();watchLogin();
readJSON('/api/me').then(me=>{if(!me.role&&isLoginVisible())void startGuard();}).catch(()=>{if(isLoginVisible())void startGuard();});
