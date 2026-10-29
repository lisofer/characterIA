// Carmen es una llamada Gemini Live propia del acceso. No modifica la llamada de NEXO.
const $=selector=>document.querySelector(selector);
const login=$('#login-view'),dock=$('#carmen-dock'),face=$('#carmen-face');
const images=$('#carmen-images'),caption=$('#carmen-caption'),state=$('#carmen-state');
const buttonCall=$('#carmen-call'),buttonMic=$('#carmen-mic');
const frameNames=['Ojos abiertos · Reposo','Ojos cerrados · Reposo','Ojos abiertos · A','Ojos cerrados · A','Ojos abiertos · O','Ojos cerrados · O','Ojos abiertos · E','Ojos cerrados · E'];
const fallbackVoices=['Aoede','Zephyr','Kore','Leda','Puck','Charon'];
let settings={},available=Array(8).fill(false),frameElements=[],currentFrame=-1;
let socket=null,desired=false,manuallyStopped=false,micMuted=false,micStream=null,micContext=null,micProcessor=null,micSource=null;
let output=null,volume=null,playHead=0,segments=[],renderId=0,blinkAt=performance.now()+4200,blinkUntil=0,mouthValue=0;
let transcript='',turnEnded=false,speechEnd=0,pendingTicket='',redeeming=false,retryTimer=null,retries=0,initializing=false;
let loadedAdmin=false,frameVersions=Array(8).fill(0),lastFrameTime=0;
const isLogin=()=>!login.classList.contains('hidden');
const setState=text=>{state.textContent=text;};
const notify=text=>{const toast=$('#toast');if(!toast)return;toast.textContent=text;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),3500);};
async function getJSON(url,options={}){
 const response=await fetch(url,{credentials:'same-origin',...options,headers:{...(options.body&&!(options.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...options.headers}});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||'No se pudo completar la operación.');
 return data;
}
function updateView(){
 dock.classList.toggle('carmen-disconnected',!desired);
 buttonMic.classList.toggle('active',!micMuted&&!!micStream);
 buttonMic.setAttribute('aria-pressed',String(!micMuted));
 buttonCall.setAttribute('aria-label',desired?'Colgar la llamada de Carmen':'Llamar a Carmen');
}
function applySettings(){
 dock.style.setProperty('--carmen-scale',String((settings.avatarScale??90)/100));
 dock.style.setProperty('--carmen-x',String(settings.avatarOffsetX??0)+'px');
 dock.style.setProperty('--carmen-y',String(settings.avatarOffsetY??0)+'px');
 caption.style.fontSize=String(settings.subtitleFont??17)+'px';
}
function setFrame(i){
 const valid=available[i]?i:available[i%2]?i%2:available[0]?0:-1;
 if(valid===currentFrame)return;
 if(valid>=0&&!frameElements[valid]?.naturalWidth)return;
 if(currentFrame>=0)frameElements[currentFrame]?.classList.remove('is-visible');
 currentFrame=valid;
 if(valid>=0)frameElements[valid]?.classList.add('is-visible');
 $('.carmen-fallback').classList.toggle('hidden',valid>=0);
}
async function fetchFrames(){
 const root=images;root.replaceChildren();frameElements=[];currentFrame=-1;
 const load=async i=>{
  if(!available[i])return;
  const img=document.createElement('img');
  img.className='carmen-frame';img.alt='';img.decoding='async';img.draggable=false;
  frameElements[i]=img;root.append(img);
  img.src='/api/carmen/frames/'+i+'?v='+(frameVersions[i]||0);
  try{await img.decode();if(i===0||currentFrame===-1)setFrame(0);}
  catch{available[i]=false;img.remove();}
 };
 await load(0);
 const order=[2,4,6,1,3,5,7];let cursor=0;
 const run=async()=>{while(cursor<order.length)await load(order[cursor++]);};
 void Promise.all([run(),run()]);
}
function makeOutput(){
 if(!output){
  output=new (window.AudioContext||window.webkitAudioContext)({sampleRate:24000});
  volume=output.createGain();volume.gain.value=.94;volume.connect(output.destination);
 }
 if(!renderId)renderId=requestAnimationFrame(render);
 return output;
}
async function unlockAudio(){
 if(!isLogin())return;
 try{
  const ctx=makeOutput();
  if(ctx.state==='suspended')await ctx.resume();
  if(micContext?.state==='suspended')await micContext.resume();
  if(ctx.state==='running'&&desired)setState(micMuted?'Micrófono silenciado':'Carmen está escuchando');
 }catch{setState('Podés ingresar la contraseña con el teclado.');}
}
function floatsFromPCM(base64){
 const binary=atob(base64),data=new Float32Array(binary.length/2);
 for(let i=0;i<data.length;i++){
  let v=binary.charCodeAt(i*2)|(binary.charCodeAt(i*2+1)<<8);
  if(v>32767)v-=65536;data[i]=v/32768;
 }
 return data;
}
function playPCM(base64){
 if(!base64||!desired)return;
 const ctx=makeOutput(),samples=floatsFromPCM(base64);
 const audio=ctx.createBuffer(1,samples.length,24000);
 audio.getChannelData(0).set(samples);
 const source=ctx.createBufferSource();source.buffer=audio;source.connect(volume);
 const start=Math.max(ctx.currentTime+.025,playHead);
 source.start(start);
 const end=start+audio.duration;playHead=end;speechEnd=end;
 segments.push({start,end,samples});
 source.onended=()=>{segments=segments.filter(x=>x.end>ctx.currentTime-.15);};
 if(ctx.state==='suspended')setState('Tocá a Carmen para escucharla');
}
function levelAt(t){
 let energy=0;
 for(const seg of segments){
  if(t<seg.start||t>seg.end)continue;
  const at=Math.floor((t-seg.start)*24000);
  const from=Math.max(0,at-240),to=Math.min(seg.samples.length,at+240);
  let sum=0;
  for(let i=from;i<to;i+=2)sum+=seg.samples[i]*seg.samples[i];
  energy=Math.max(energy,Math.sqrt(sum/Math.max(1,(to-from)/2)));
 }
 return energy;
}
const canvas=document.createElement('canvas'),measure=canvas.getContext('2d');
function paintCaption(){
 if(!transcript.trim())return;
 const t=output?.currentTime??0;
 const audioStarted=segments.length?segments[0].start:(speechEnd?Math.max(0,speechEnd-2):0);
 const words=transcript.trim().split(/\s+/);
 const duration=Math.max(.7,speechEnd-audioStarted);
 const progress=Math.min(1,Math.max(0,(t-audioStarted-(Number(settings.subtitleDelay||0)/1000))/duration));
 const endIndex=Math.min(words.length,Math.max(1,Math.floor(progress*words.length)+1));
 measure.font='700 '+(settings.subtitleFont||17)+'px Arial';
 const maxWidth=Math.max(125,caption.clientWidth-20);
 let result='';
 for(let i=endIndex-1;i>=0;i--){
  const next=words[i]+(result?' '+result:'');
  if(measure.measureText(next).width>maxWidth&&result)break;
  result=next;
 }
 if(caption.textContent!==result)caption.textContent=result;
}
function render(now){
 renderId=requestAnimationFrame(render);
 if(!isLogin()||!desired)return;
 if(now-lastFrameTime<55)return;
 lastFrameTime=now;
 const t=output?.currentTime??0;
 const raw=levelAt(t-Number(settings.mouthDelay||0)/1000);
 const sensitivity=Number(settings.mouthSensitivity??48)/100;
 const value=Math.max(0,Math.min(1,(raw-.014)*(.9+7*sensitivity)));
 const smooth=Number(settings.mouthSmoothing??40)/100;
 mouthValue=mouthValue*(.18+smooth*.76)+value*(.82-smooth*.76);
 const scaled=mouthValue*Number(settings.mouthAmplitude??78)/100;
 const speaking=t<speechEnd+.06&&raw>.01;
 if(now>blinkAt){blinkUntil=now+115;blinkAt=now+Number(settings.blinkRate||4.2)*1000;}
 const closed=now<blinkUntil?1:0;
 const mouth=speaking?(scaled>.42?2:scaled>.18?1:0):0;
 const variant=Math.min(7,mouth*2+closed);
 setFrame(variant);
 if(transcript)paintCaption();
}
function resetAudio(){
 segments=[];playHead=0;speechEnd=0;transcript='';turnEnded=false;
 caption.textContent=' ';setFrame(0);
}
function haltMic(){
 if(micProcessor){try{micProcessor.disconnect();micSource?.disconnect();}catch{}}
 micStream?.getTracks().forEach(t=>t.stop());
 micContext?.close().catch(()=>{});
 micStream=null;micContext=null;micProcessor=null;micSource=null;updateView();
}
function pauseMic(paused){
 micMuted=paused;
 micStream?.getAudioTracks().forEach(track=>{track.enabled=!paused;});
 updateView();
 if(desired)setState(paused?'Micrófono silenciado':'Carmen está escuchando');
}
async function startMic(){
 if(!desired||micMuted||micStream||!navigator.mediaDevices?.getUserMedia)return;
 try{
  const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  if(!desired){stream.getTracks().forEach(t=>t.stop());return;}
  const context=new (window.AudioContext||window.webkitAudioContext)();
  if(context.state==='suspended')context.resume().catch(()=>{});
  const source=context.createMediaStreamSource(stream);
  const proc=context.createScriptProcessor(2048,1,1);
  const silent=context.createGain();silent.gain.value=0;
  source.connect(proc);proc.connect(silent);silent.connect(context.destination);
  micStream=stream;micContext=context;micProcessor=proc;micSource=source;
  proc.onaudioprocess=event=>{
   if(micMuted||!desired||!socket||socket.readyState!==WebSocket.OPEN||socket.bufferedAmount>180000||pendingTicket)return;
   const sourceSamples=event.inputBuffer.getChannelData(0);
   const ratio=context.sampleRate/16000,n=Math.floor(sourceSamples.length/ratio),pcm=new Int16Array(n);
   for(let i=0;i<n;i++){
    const from=Math.floor(i*ratio),until=Math.min(sourceSamples.length,Math.floor((i+1)*ratio));
    let sum=0;for(let j=from;j<until;j++)sum+=sourceSamples[j];
    const value=Math.max(-1,Math.min(1,sum/Math.max(1,until-from)));
    pcm[i]=Math.round(value*(value<0?32768:32767));
   }
   const bytes=new Uint8Array(pcm.buffer);let binary='';
   for(let i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
   socket.send(JSON.stringify({type:'audio',pcm:btoa(binary)}));
  };
  if(micMuted)pauseMic(true);else{setState('Carmen está escuchando');updateView();}
 }catch{
  setState('Podés usar el teclado para ingresar');
  micMuted=true;updateView();
 }
}
function stop({manual=true}={}){
 desired=false;manuallyStopped=manual;clearTimeout(retryTimer);retryTimer=null;
 if(renderId){cancelAnimationFrame(renderId);renderId=0;}
 if(socket){socket.onclose=null;socket.close();socket=null;}
 haltMic();resetAudio();
 if(output){output.close().catch(()=>{});output=null;volume=null;}
 setState(manual?'Llamada terminada':'');updateView();
}
function reconnectSoon(){
 if(!desired||!isLogin()||manuallyStopped||retryTimer)return;
 const delay=Math.min(900*Math.pow(1.8,Math.min(retries++,5)),9500);
 setState('Reconectando a Carmen…');
 retryTimer=setTimeout(()=>{retryTimer=null;if(desired)openSocket();},delay);
}
function maybeFinish(){
 if(!pendingTicket||redeeming)return;
 const remain=Math.max(0,(speechEnd-(output?.currentTime??0))*1000);
 setTimeout(()=>{if(pendingTicket&&!redeeming)void redeemTicket();},Math.min(4800,remain+350));
}
async function redeemTicket(){
 if(!pendingTicket||redeeming)return;
 const ticket=pendingTicket;pendingTicket='';redeeming=true;
 setState('Verificando el acceso…');
 try{
  const response=await getJSON('/api/carmen/redeem',{method:'POST',body:JSON.stringify({ticket})});
  stop({manual:false});
  window.dispatchEvent(new CustomEvent('carmen-authenticated',{detail:{role:response.role}}));
 }catch(error){
  redeeming=false;setState(error.message);notify(error.message);
  // Una autorización expirada obliga a dictar o escribir una nueva contraseña.
 }
}
function openSocket(){
 if(!desired||!isLogin())return;
 const address=(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/api/carmen/live';
 const ws=new WebSocket(address);socket=ws;
 ws.onmessage=event=>{
  if(socket!==ws||!desired)return;
  let msg;try{msg=JSON.parse(event.data);}catch{return;}
  switch(msg.type){
   case 'connected':retries=0;setState('Conectada · Gemini Live');ws.send(JSON.stringify({type:'start'}));break;
   case 'transcript':transcript+=String(msg.text||'');turnEnded=false;break;
   case 'audio':playPCM(msg.pcm);break;
   case 'turn_complete':turnEnded=true;if(pendingTicket)maybeFinish();else setTimeout(()=>{if(turnEnded&&!pendingTicket){transcript='';caption.textContent=' ';}},Math.max(900,((speechEnd-(output?.currentTime||0))*1000)+650));break;
   case 'access_granted':pendingTicket=msg.ticket;pauseMic(true);setState('Contraseña correcta');setTimeout(maybeFinish,750);setTimeout(()=>{if(pendingTicket)void redeemTicket();},5200);break;
   case 'interrupted':segments=[];playHead=output?.currentTime||0;speechEnd=playHead;transcript='';break;
   case 'notice':setState(msg.message||'Conectada');break;
   case 'error':setState(msg.message||'Carmen no pudo conectarse. Podés escribir la contraseña.');break;
  }
 };
 ws.onclose=()=>{if(socket!==ws)return;socket=null;if(desired)reconnectSoon();};
 ws.onerror=()=>{if(socket===ws)setState('Problema de conexión. Podés escribir la contraseña.');};
}
async function start(){
 if(initializing||desired||!isLogin())return;
 initializing=true;manuallyStopped=false;desired=true;redeeming=false;pendingTicket='';micMuted=false;updateView();setState('Conectando a Carmen…');
 try{
  const config=await getJSON('/api/carmen/config');
  if(!desired)return;
  settings=config.config||{};available=config.frames||Array(8).fill(false);
  applySettings();await fetchFrames();makeOutput();openSocket();void startMic();
 }catch(error){setState('Podés ingresar con el teclado.');notify(error.message);}
 finally{initializing=false;}
}
function setupControls(){
 face.addEventListener('click',()=>void unlockAudio());
 buttonCall.onclick=()=>{if(desired)stop();else void start();};
 buttonMic.onclick=()=>{
  void unlockAudio();
  if(!desired){void start();return;}
  if(micMuted){pauseMic(false);if(!micStream)void startMic();}
  else pauseMic(true);
 };
 $('#carmen-keyboard').onclick=()=>{void unlockAudio();$('#password').focus();};
 $('#carmen-restart').onclick=()=>{stop({manual:false});void start();};
 $('#password').addEventListener('focus',()=>{if(desired&&!micMuted)pauseMic(true);});
 window.addEventListener('nexo-login-ok',()=>stop({manual:false}));
 window.addEventListener('nexo-login-error',()=>{
  if(desired&&socket?.readyState===WebSocket.OPEN)
   socket.send(JSON.stringify({type:'text',text:'La contraseña introducida por teclado no fue aceptada. Ofrecé volver a intentar sin pedir que diga su contraseña en voz alta.'}));
 });
 document.addEventListener('pointerdown',()=>{if(isLogin()&&desired)void unlockAudio();},{capture:true});
 new MutationObserver(()=>{
  if(!isLogin()){if(desired)stop({manual:false});}
  else if(!desired&&!manuallyStopped&&!initializing)void start();
 }).observe(login,{attributes:true,attributeFilter:['class']});
}
function updateAdminReadouts(){
 for(const output of document.querySelectorAll('[data-carmen-output]')){
  const input=document.querySelector('[data-carmen="'+output.dataset.carmenOutput+'"]');
  output.textContent=input?.value+(output.dataset.carmenOutput.toLowerCase().includes('delay')?' ms':'');
 }
 const p=$('#carmen-preview');
 if(!p.classList.contains('hidden')){
  const scale=Number(document.querySelector('[data-carmen="avatarScale"]')?.value||90)/100;
  const x=Number(document.querySelector('[data-carmen="avatarOffsetX"]')?.value||0);
  const y=Number(document.querySelector('[data-carmen="avatarOffsetY"]')?.value||0);
  p.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')';
 }
}
function displayAdminFrames(){
 const root=$('#carmen-frames');root.replaceChildren();
 $('#carmen-frame-counter').textContent=available.filter(Boolean).length+' / 8 PNG cargados';
 const p=$('#carmen-preview'),fallback=$('#carmen-preview-fallback');
 if(available[0]){p.src='/api/carmen/frames/0?v='+(frameVersions[0]||0);p.classList.remove('hidden');fallback.classList.add('hidden');}
 else{p.classList.add('hidden');fallback.classList.remove('hidden');}
 frameNames.forEach((name,i)=>{
  const card=document.createElement('div');card.className='carmen-frame-card';
  const thumb=document.createElement('div');thumb.className='carmen-admin-thumb';
  if(available[i]){const img=document.createElement('img');img.src='/api/carmen/frames/'+i+'?v='+(frameVersions[i]||0);img.alt='Fotograma '+(i+1);thumb.append(img);}
  else thumb.textContent='✦';
  const title=document.createElement('span');title.textContent=name;
  const label=document.createElement('label');label.textContent=available[i]?'Reemplazar PNG':'Cargar PNG';label.className='carmen-frame-upload';
  const input=document.createElement('input');input.type='file';input.accept='image/png';input.setAttribute('aria-label','Cargar '+name);label.append(input);
  input.onchange=async()=>{
   const file=input.files?.[0];if(!file)return;
   const data=new FormData();data.append('image',file);
   try{
    await getJSON('/api/admin/carmen/frames/'+i,{method:'POST',body:data});
    available[i]=true;frameVersions[i]++;displayAdminFrames();
    $('#carmen-admin-status').textContent='Fotograma '+(i+1)+' guardado.';
   }catch(error){$('#carmen-admin-status').textContent=error.message;}
  };
  card.append(thumb,title,label);root.append(card);
 });
 updateAdminReadouts();
}
async function loadCarmenAdmin(){
 if(loadedAdmin)return;
 try{
  const data=await getJSON('/api/admin/carmen/config');
  settings=data.config||{};available=data.frames||Array(8).fill(false);
  const selector=$('#carmen-voice');
  selector.replaceChildren(...(data.voices||fallbackVoices).map(voice=>new Option(voice,voice)));
  for(const input of document.querySelectorAll('[data-carmen]')){
   if(Object.hasOwn(settings,input.dataset.carmen))input.value=settings[input.dataset.carmen];
  }
  loadedAdmin=true;displayAdminFrames();
  if(!data.geminiReady)$('#carmen-admin-status').textContent='Falta configurar Gemini Live.';
 }catch(error){$('#carmen-admin-status').textContent=error.message;}
}
function setupAdmin(){
 document.querySelector('[data-pane="carmen"]')?.addEventListener('click',()=>void loadCarmenAdmin());
 for(const input of document.querySelectorAll('[data-carmen]'))input.addEventListener('input',updateAdminReadouts);
 $('#carmen-save').onclick=async()=>{
  const config={};
  for(const input of document.querySelectorAll('[data-carmen]')){
   config[input.dataset.carmen]=input.type==='range'?Number(input.value):input.value;
  }
  try{
   const result=await getJSON('/api/admin/carmen/config',{method:'PUT',body:JSON.stringify({config})});
   settings=result.config;$('#carmen-admin-status').textContent='Configuración de Carmen guardada.';
  }catch(error){$('#carmen-admin-status').textContent=error.message;}
 };
 $('#carmen-voice-test').onclick=async()=>{
  const btn=$('#carmen-voice-test');btn.disabled=true;
  try{
   const response=await fetch('/api/admin/carmen/voice-sample',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voice:$('#carmen-voice').value})});
   if(!response.ok){const error=await response.json().catch(()=>({}));throw Error(error.error||'No se pudo reproducir la voz');}
   const blob=await response.blob(),url=URL.createObjectURL(blob),audio=new Audio(url);
   audio.onended=()=>URL.revokeObjectURL(url);
   await audio.play();$('#carmen-admin-status').textContent='Reproduciendo voz de Carmen…';
  }catch(error){$('#carmen-admin-status').textContent=error.message;}
  finally{btn.disabled=false;}
 };
}
// La página de ingreso conserva el formulario habitual como alternativa siempre disponible.
setupControls();setupAdmin();
getJSON('/api/me').then(data=>{if(!data.role&&isLogin())void start();}).catch(()=>{if(isLogin())void start();});
