const $=sel=>document.querySelector(sel),$$=sel=>[...document.querySelectorAll(sel)];
const el={login:$('#login-view'),student:$('#student-view'),admin:$('#admin-view'),subtitle:$('#subtitle-text'),subBox:$('#subtitle'),avatar:$('#avatar-images'),placeholder:$('#avatar-placeholder')};
const VOICES=['Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat'];
let audioSegments=[];let role=null,config={},frames=Array(8).fill(false),ws=null,microphone=null,mediaStream=null,processor=null,sourceNode=null,micOn=false,audioContext=null,gain=null,analyser=null,nextAudioTime=0,animationId=0,blinkingUntil=0,nextBlink=0,currentFrame=-1,subtitleLine='',subtitleCarry='',spokenText='',smoothedEnergy=0,currentModel='',roleLoading=false;
const toast=(msg)=>{const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('show'),4500)};
async function api(url,opt={}){const r=await fetch(url,{credentials:'same-origin',...opt,headers:{...(opt.body&&! (opt.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...opt.headers}});let data;try{data=await r.json()}catch{data={error:'Respuesta inesperada'}}if(!r.ok)throw Error(data.error||`Error ${r.status}`);return data}
const post=(url,body)=>api(url,{method:'POST',body:JSON.stringify(body)});
const setVisible=view=>{for(const v of ['login','student','admin'])el[v].classList.toggle('hidden',view!==v)};
function setupAuth(){const form=$('#login-form');form.addEventListener('submit',async e=>{e.preventDefault();if(roleLoading)return;roleLoading=true;ensureAudio().catch(()=>{});const b=$('#login-btn');b.disabled=true;b.textContent='Ingresando…';try{const data=await post('/api/login',{password:$('#password').value});$('#password').value='';await restoreRole(data.role);}catch(err){toast(err.message)}finally{roleLoading=false;b.disabled=false;b.innerHTML='Ingresar <span>↗</span>';}});$('#toggle-password').addEventListener('click',()=>{const t=$('#password');t.type=t.type==='password'?'text':'password';});
 $('#student-logout').addEventListener('click',logout);$('#admin-logout').addEventListener('click',logout)}
async function logout(){stopCall();try{await post('/api/logout',{})}catch{}role=null;setVisible('login')}
async function restoreRole(force){let me=await api('/api/me');role=force||me.role;if(role==='student'){setVisible('student');applySettings(me.config||{});setDocuments(me.documents||[]);await refreshFrames();await connectLive();}else if(role==='admin'){setVisible('admin');await loadAdmin();}else setVisible('login');}
async function refreshFrames(){
 frames=await Promise.all(Array.from({length:8},(_,i)=>fetch(`/api/frames/${i}`,{method:'HEAD',cache:'no-store'}).then(r=>r.ok).catch(()=>false)));
 const parent=el.avatar;parent.replaceChildren();
 for(let i=0;i<8;i++){
  const img=document.createElement('img');img.className='avatar-frame';img.alt='';img.draggable=false;img.dataset.frame=String(i);
  if(frames[i]){img.src=`/api/frames/${i}?v=${frameVersions[i]||0}`;img.decode?.().catch(()=>{});}
  parent.appendChild(img);
 }
 currentFrame=-1;showFrame(0);
}
function applySettings(c){
 config={...config,...c};
 document.documentElement.style.setProperty('--subtitle-size',(config.subtitleFont||20)+'px');
 document.documentElement.style.setProperty('--subtitle-width',(config.subtitleWidth||760)+'px');
 const s=(config.avatarScale??100)/100;
 // Si el PNG es muy alto, contain mantiene cabeza y torso completos dentro del escenario.
 el.avatar.style.setProperty('--avatar-scale',Math.max(.5,Math.min(1.2,s)));
 el.avatar.style.setProperty('--avatar-x',(config.avatarOffsetX||0)+'px');
 el.avatar.style.setProperty('--avatar-y',(config.avatarOffsetY||0)+'px');
 el.avatar.querySelectorAll('.avatar-frame').forEach(img=>img.style.objectFit='contain');
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
let captionRaw='',captionWords=[],captionShown=0,captionFinished=false,captionLine='',captionCurrentWord='',firstAudioTime=null,finalAudioTime=0;
let sources=new Set(), micPending=false, connectAttempt=0, playbackGeneration=0;

// Solo muestra texto que entre en una línea. Mide píxeles, nunca divide palabras.
const measureCanvas=document.createElement('canvas'),ctx=measureCanvas.getContext('2d');
function textFits(t){const f=parseInt(getComputedStyle(el.subBox).fontSize)||20;ctx.font=`700 ${f}px 'DM Sans',Arial,sans-serif`;return ctx.measureText(t).width<=Math.max(50,el.subBox.clientWidth-35)}
function showSubtitle(text){el.subtitle.textContent=text||' ';el.subtitle.style.fontSize='';if(text&&!textFits(text)){let n=parseInt(getComputedStyle(el.subBox).fontSize);while(n>13){n-=1;ctx.font=`700 ${n}px 'DM Sans',Arial,sans-serif`;if(ctx.measureText(text).width<el.subBox.clientWidth-24){el.subtitle.style.fontSize=n+'px';break}}const fs=parseInt(el.subtitle.style.fontSize)||n;ctx.font=`700 ${fs}px 'DM Sans',Arial,sans-serif`;const width=ctx.measureText(text).width;const max=el.subBox.clientWidth-22;if(width>max)el.subtitle.style.transform=`scaleX(${max/width})`;else el.subtitle.style.transform='';}else{el.subtitle.style.transform='';}}
// Subtítulos ligados al reloj de los fragmentos PCM reproducidos, NO a la llegada del texto.
function resetSubtitle(){captionRaw='';captionWords=[];captionShown=0;captionFinished=false;captionLine='';captionCurrentWord='';spokenText='';subtitleLine='';showSubtitle(' ')}
function pushSubtitle(text){
 if(!text)return;
 // Algunos modelos envían texto incremental; otros retransmiten un prefijo acumulado.
 if(text.startsWith(captionRaw) && captionRaw.length)captionRaw=text;
 else if(!captionRaw.endsWith(text))captionRaw+=text;
 captionWords=(captionRaw.match(/\S+/g)||[]);
 spokenText=captionRaw;
}
function beginResponseIfNeeded(){
 if(captionFinished && audioContext && audioContext.currentTime>=finalAudioTime-.08){resetSubtitle();firstAudioTime=null;finalAudioTime=0}
}
function renderCaptions(){
 if(!audioContext||firstAudioTime===null)return;
 const now=audioContext.currentTime;
 if(now<firstAudioTime)return;
 const elapsed=Math.max(0,now-firstAudioTime);
 // Velocidad aproximada durante streaming. Al cerrar el turno se ajusta a la duración real del audio.
 const totalDuration=Math.max(.05,finalAudioTime-firstAudioTime);
 const target=captionFinished?
   Math.floor(Math.min(1,elapsed/totalDuration)*captionWords.length+0.001):
   Math.floor(elapsed*2.85);
 const upto=Math.min(captionWords.length,Math.max(captionShown, target));
 while(captionShown<upto){
  const word=captionWords[captionShown++];
  const next=captionLine?captionLine+' '+word:word;
  captionLine=captionLine&&!textFits(next)?word:next;
  captionCurrentWord=word;
  showSubtitle(captionLine);
 }
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
  const start=Math.max(audioContext.currentTime+(firstAudioTime===null?.30:.035),nextAudioTime);
  if(firstAudioTime===null)firstAudioTime=start;
  nextAudioTime=start+buff.duration;finalAudioTime=nextAudioTime;
  src.start(start);sources.add(src);src.onended=()=>{sources.delete(src);try{src.disconnect()}catch{}};
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
  // Fonemas aproximados: la palabra escuchada orienta E/O/A; energía y tiempo determinan cuándo abrir/cerrar.
  const vowels=(captionCurrentWord.toLowerCase().match(/[aeoáéó]/g)||[]).map(v=>v==='ó'?'o':v==='é'?'e':v==='á'?'a':v);
  const idx=Math.floor((audioContext.currentTime-firstAudioTime)*7.1)%Math.max(1,vowels.length);
  const base=vowels[idx]||(['a','o','e'][Math.floor((audioContext.currentTime-firstAudioTime)*4.7)%3]);
  const phase=Math.floor((audioContext.currentTime-firstAudioTime)*5.8)%5;
  const v=(vowels.length<2&&phase===3)?'o':(vowels.length<2&&phase===4)?'a':base;
  shape=v==='o'?2:v==='e'?3:1;
 }
 const index=shape===0?blink:shape*2+blink;
 el.placeholder.classList.toggle('talking',talking);
 showFrame(index);
 audioSegments=audioSegments.filter(x=>x.end>(audioContext?.currentTime||0)-.2);
}
function setStatus(label,connected=false){$('#connection-label').textContent=label;$('.status-dot').classList.toggle('connected',connected);$('#call-btn').title=connected?'Colgar llamada':'Iniciar llamada';}
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
    currentModel=m.model;setStatus(m.fallback?'Respaldo':'Conectado',true);
    socket.send(JSON.stringify({type:'start'}));
    if(micPending){micPending=false;startMicrophone().catch(()=>{});}
    break;
   case 'transcript':pushSubtitle(m.text);break;
   case 'audio':playAudio(m.pcm);break;
   case 'input_transcript':break;
   case 'turn_complete':captionFinished=true;break;
   case 'profile':break;
   case 'document':setDocuments([{id:m.id}]);toast('Currículum listo para descargar');break;
   case 'interrupted':stopPlayback(true);break;
   case 'error':toast(m.message);setStatus('Error');break;
   case 'notice':toast(m.message);break;
   case 'closed':setStatus('Desconectado');break;
  }
 };
 socket.onclose=()=>{if(attempt!==connectAttempt)return;setStatus('Desconectado');stopMicrophone();stopPlayback();};
 socket.onerror=()=>{if(attempt!==connectAttempt)return;setStatus('Error de red');toast('No se pudo abrir la llamada.')};
}
function stopCall(){
 connectAttempt++;micPending=false;stopMicrophone();
 if(ws){ws.onclose=null;try{ws.close()}catch{}ws=null}
 stopPlayback();setStatus('Desconectado');
}
async function startMicrophone(){
 if(micOn)return;
 try{
  await ensureAudio(true);
  if(!ws||ws.readyState!==WebSocket.OPEN){micPending=true;await connectLive();return;}
  mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  microphone=new (window.AudioContext||window.webkitAudioContext)();
  if(microphone.state==='suspended')await microphone.resume();
  sourceNode=microphone.createMediaStreamSource(mediaStream);
  processor=microphone.createScriptProcessor(4096,1,1);
  sourceNode.connect(processor);const silent=microphone.createGain();silent.gain.value=0;processor.connect(silent);silent.connect(microphone.destination);
  processor.onaudioprocess=e=>{
   if(!micOn||!ws||ws.readyState!==1)return;
   const input=e.inputBuffer.getChannelData(0),rate=microphone.sampleRate,ratio=rate/16000,n=Math.floor(input.length/ratio),out=new Int16Array(n);
   for(let j=0;j<n;j++){
    const from=Math.floor(j*ratio),to=Math.min(input.length,Math.floor((j+1)*ratio));let sum=0;
    for(let k=from;k<to;k++)sum+=input[k];
    const val=Math.max(-1,Math.min(1,sum/Math.max(1,to-from)));
    out[j]=val<0?val*32768:val*32767;
   }
   const bytes=new Uint8Array(out.buffer);let str='';for(const b of bytes)str+=String.fromCharCode(b);
   ws.send(JSON.stringify({type:'audio',pcm:btoa(str)}));
  };
  micOn=true;$('#mic-btn').classList.add('active');$('#mic-btn').setAttribute('aria-pressed','true');
 }catch(e){toast('Micrófono: '+e.message);stopMicrophone()}
}
function stopMicrophone(){
 if(micOn&&ws?.readyState===1)ws.send(JSON.stringify({type:'audio_end'}));
 micOn=false;try{processor?.disconnect();sourceNode?.disconnect()}catch{}
 mediaStream?.getTracks().forEach(t=>t.stop());microphone?.close().catch(()=>{});
 processor=null;sourceNode=null;mediaStream=null;microphone=null;
 $('#mic-btn').classList.remove('active');$('#mic-btn').setAttribute('aria-pressed','false');
}
function setDocuments(docs){const doc=docs[0];$('#document-strip').classList.toggle('hidden',!doc);if(doc)$('#download-link').href=`/api/cv/${encodeURIComponent(doc.id)}`}
function setupStudent(){
 $('#call-btn').onclick=async()=>{
  if(ws&&(ws.readyState===0||ws.readyState===1))stopCall();
  else{ensureAudio(true).catch(()=>{});await connectLive()}
 };
 $('#mic-btn').onclick=async()=>{if(micOn)stopMicrophone();else await startMicrophone()};
 $('#keyboard-btn').onclick=()=>{
  const form=$('#text-form');form.classList.toggle('hidden');
  if(!form.classList.contains('hidden'))$('#text-message').focus();
 };
 $('#text-form').onsubmit=e=>{
  e.preventDefault();const inp=$('#text-message'),txt=inp.value.trim();if(!txt)return;
  if(!ws||ws.readyState!==1){toast('Conectá la llamada primero');return}
  ws.send(JSON.stringify({type:'text',text:txt}));inp.value='';
  $('#text-form').classList.add('hidden');
 };
 $('#reset-btn').onclick=()=>$('#reset-modal').classList.remove('hidden');
 $('#cancel-reset').onclick=()=>$('#reset-modal').classList.add('hidden');
 $('#confirm-reset').onclick=async()=>{
  try{stopCall();await post('/api/reset',{confirm:true});$('#reset-modal').classList.add('hidden');setDocuments([]);resetSubtitle();await connectLive()}
  catch(e){toast(e.message)}
 };
}
// Administración: lista de ocho fotogramas y vista previa responsive.
const frameDescriptions=['Ojos abiertos · Reposo','Ojos cerrados · Reposo','Ojos abiertos · A','Ojos cerrados · A','Ojos abiertos · O','Ojos cerrados · O','Ojos abiertos · E','Ojos cerrados · E'];
function buildFrames(){const root=$('#frames-grid');root.innerHTML='';frameDescriptions.forEach((name,i)=>{const card=document.createElement('div');card.className='frame-card';card.innerHTML=`<div class="frame-thumb"><span class="frame-num">${String(i+1).padStart(2,'0')}</span><span class="frame-placeholder">✧</span><img class="hidden" alt="Fotograma ${i+1}" /></div><strong>${name}</strong><small>PNG · mismo encuadre</small><label class="frame-upload">${frames[i]?'Reemplazar PNG':'Subir PNG'} <input type="file" accept="image/png" aria-label="Cargar imagen ${i+1}"></label>`;if(frames[i]){const img=card.querySelector('img');img.src=`/api/frames/${i}?v=${Date.now()}`;img.classList.remove('hidden');card.querySelector('.frame-placeholder').classList.add('hidden')};card.querySelector('input').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;const fd=new FormData();fd.append('image',file);try{const out=await api(`/api/admin/frames/${i}`,{method:'POST',body:fd});frames[i]=true;frameVersions[i]++;buildFrames();updatePreviewImage();toast(`Imagen ${i+1} guardada: ${out.width} × ${out.height} px`);}catch(err){toast(err.message)}};root.appendChild(card)});$('#frames-count').textContent=`${frames.filter(Boolean).length} / 8 cargadas`}
function updatePreviewImage(){const img=$('#admin-preview-img');if(frames[0]){img.src=`/api/frames/0?v=${frameVersions[0]||0}`;img.classList.remove('hidden');$('.avatar-mini-fallback').classList.add('hidden')}else{img.classList.add('hidden');$('.avatar-mini-fallback').classList.remove('hidden')}const s=Number($('[data-setting="avatarScale"]')?.value||100)/100, x=Number($('[data-setting="avatarOffsetX"]')?.value||0),y=Number($('[data-setting="avatarOffsetY"]')?.value||0);img.style.transform=`translate(${x}px,${y}px) scale(${s})`;img.style.objectFit=$('[data-setting="avatarFit"]')?.value||'contain';}
function syncOutputs(){for(const o of $$('output[data-for]')){const inp=$(`[data-setting="${o.dataset.for}"]`);if(inp)o.textContent=inp.value+(o.dataset.for==='mouthDelay'?' ms':o.dataset.for==='blinkRate'?' s':o.dataset.for==='subtitleWidth'?' px':o.dataset.for==='subtitleFont'?' px':'');}updatePreviewImage()}
async function loadAdmin(){const data=await api('/api/admin/config');config=data.config;frames=data.frames;buildFrames();$('#voice-select').innerHTML=(data.voices||VOICES).map(x=>`<option value="${x}">${x}</option>`).join('');for(const inp of $$('[data-setting]')){const val=config[inp.dataset.setting];if(val!==undefined)inp.value=val;}syncOutputs();if(!data.geminiReady)toast('Falta GEMINI_API_KEY para activar llamadas y muestras de voz.');}
function setupAdmin(){$$('#admin-nav .nav-item').forEach(b=>b.onclick=()=>{const name=b.dataset.pane;$$('#admin-nav .nav-item').forEach(x=>x.classList.toggle('selected',x===b));$$('.admin-pane').forEach(p=>p.classList.toggle('hidden',p.dataset.pane!==name));$('#admin-title').innerHTML={appearance:'Personaje y <em>vista previa</em>',voice:'Voz e <em>inteligencia</em>',behavior:'Personalidad del <em>personaje</em>',accessibility:'Accesibilidad y <em>sincronía</em>'}[name];});$$('[data-setting]').forEach(inp=>inp.addEventListener('input',syncOutputs));$$('.device-btn').forEach(b=>b.onclick=()=>{$$('.device-btn').forEach(x=>x.classList.toggle('selected',x===b));$('#admin-preview').classList.toggle('mobile',b.dataset.device==='mobile')});$('#save-settings').onclick=async()=>{const next={};for(const i of $$('[data-setting]'))next[i.dataset.setting]=i.type==='range'?Number(i.value):i.value;try{const saved=await api('/api/admin/config',{method:'PUT',body:JSON.stringify({config:next})});config=saved.config;toast('Configuración guardada en Railway.')}catch(e){toast(e.message)}};$('#test-voice').onclick=async()=>{const btn=$('#test-voice'),status=$('#voice-test-status');btn.disabled=true;btn.textContent='Preparando muestra…';status.textContent='Generando audio con la voz seleccionada…';try{const r=await fetch('/api/admin/voice-sample',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voice:$('#voice-select').value})});if(!r.ok){const data=await r.json();throw Error(data.error||'Error de voz')}const blob=await r.blob(),url=URL.createObjectURL(blob),a=new Audio(url);a.onended=()=>URL.revokeObjectURL(url);await a.play();status.textContent=`Reproduciendo · ${r.headers.get('X-Gemini-Model')||'Gemini Live'}`;}catch(e){status.textContent='No se pudo generar la muestra: '+e.message;toast(e.message)}finally{btn.disabled=false;btn.textContent='▶ Escuchar prueba'}}}
setupAuth();setupStudent();setupAdmin();
const isLocal=['localhost','127.0.0.1'].includes(location.hostname);
if(isLocal&&new URLSearchParams(location.search).get('demo')){const demo=new URLSearchParams(location.search).get('demo');if(demo==='student'){setVisible('student');applySettings({subtitleFont:20,subtitleWidth:760,avatarScale:100});showFrame(0);setStatus('Conectado',true);$('#connection-label').textContent='Vista previa';}else if(demo==='admin'){setVisible('admin');config={avatarScale:100,avatarOffsetX:0,avatarOffsetY:0,avatarFit:'contain',model:'gemini-3.8-live',fallback:'gemini-3.1-flash-live-preview',voice:'Aoede'};buildFrames();syncOutputs();}else setVisible('login');}
else restoreRole().catch(()=>setVisible('login'));