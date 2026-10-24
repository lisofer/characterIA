'use strict';
const $=id=>document.getElementById(id);
const loginView=$('loginView'),studentView=$('studentView'),subtitle=$('subtitle'),statusEl=$('status');
let config=null,session=null,busy=false,recognition=null,listening=false,micStart=0;
let voiceAudio=null,avatarLoop=0,lastPrompt='',blinkUntil=0,lastBlink=0,lipPlan=null,speechToken=0,sourceUrl=null;
let micActive=false,micText='',micSilenceTimer=null,micSessionId=0,micError='';
async function api(path,options={}){const r=await fetch(path,{credentials:'same-origin',...options});const content=r.headers.get('content-type')||'';const data=content.includes('application/json')?await r.json():null;if(!r.ok)throw Error(data?.error||('Error HTTP '+r.status));return data}
const json=(method,body)=>({method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
function tell(msg){statusEl.textContent=msg}
function imageState(i){const src=config?.images?.[String(i)]||config?.images?.[i];const idle=config?.images?.['0'];const img=$('avatar');if(!src&&!idle){img.hidden=true;$('avatarPlaceholder').hidden=false;return}const target=src||idle;const url=new URL(target,location.href).href;if(img.src!==url)img.src=url;img.hidden=false;$('avatarPlaceholder').hidden=true}

const spritePreloads=[];
function preloadSprites(){spritePreloads.length=0;for(let i=0;i<8;i++){const path=config?.images?.[String(i)];if(!path)continue;const img=new Image();img.src=path;spritePreloads.push(img)}}
function applyAppearance(){
 const f=$('avatarButton'),settings=config?.appearance||{};
 f.style.setProperty('--sprite-scale',String(settings.scale??1));
 f.style.setProperty('--sprite-offset-x',String(settings.offsetX??0)+'%');
 f.style.setProperty('--sprite-offset-y',String(settings.offsetY??0)+'%');
}
function animate(){
 cancelAnimationFrame(avatarLoop);
 let blinkAt=performance.now()+2600;
 const frame=()=>{
  const now=performance.now(),talking=!!(voiceAudio&&!voiceAudio.paused&&!voiceAudio.ended);
  const mouth=talking&&window.PersonaLipSync?window.PersonaLipSync.pose(lipPlan,(voiceAudio.currentTime||0)*1000,(voiceAudio.duration||0)*1000,config?.lipSync||{}):0;
  if(now>blinkAt){blinkUntil=now+125;blinkAt=now+Number(config?.lipSync?.blinkInterval||3500)+Math.random()*500}
  const blink=config?.lipSync?.blink!==false&&now<blinkUntil;
  imageState(mouth+(blink?1:0));
  $('fallbackMouth').textContent=talking?(mouth===4?'O':mouth===6?'—':mouth?'◯':'—'):'ᴗ';
  avatarLoop=requestAnimationFrame(frame);
 };
 avatarLoop=requestAnimationFrame(frame);
}
function addLog(role,text){const e=document.createElement('div');e.className='log-entry'+(role==='user'?' you':'');e.textContent=(role==='user'?'Vos: ':'Asistente: ')+text;$('conversation').appendChild(e);if($('conversation').children.length>40)$('conversation').firstChild.remove()}
function updateSubtitle(t,log=true){lastPrompt=t;subtitle.textContent=t;if(log)addLog('assistant',t)}

function stopVoice(){
 speechToken++;
 if(voiceAudio){voiceAudio.pause();voiceAudio.removeAttribute('src');voiceAudio.load();voiceAudio=null}
 if(sourceUrl){URL.revokeObjectURL(sourceUrl);sourceUrl=null}
 window.speechSynthesis?.cancel?.();lipPlan=null;
}
function nativeVoice(text){
 if(!('speechSynthesis' in window))return;
 const u=new SpeechSynthesisUtterance(text);u.lang='es-AR';u.rate=.96;window.speechSynthesis.speak(u);
}
async function speak(text){
 stopVoice();const token=speechToken;if(!text)return;
 lipPlan=window.PersonaLipSync?.build(text)||null;
 try{
  const r=await fetch('/api/tts',json('POST',{text}));
  if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||'Voz no disponible');
  const fallbackFrom=r.headers.get('X-CV-Voice-Fallback');const chosenVoice=r.headers.get('X-CV-Voice-Source');const blob=await r.blob();if(token!==speechToken)return;
  sourceUrl=URL.createObjectURL(blob);
  const a=new Audio(sourceUrl);voiceAudio=a;
  a.onended=()=>{if(token!==speechToken)return;reportUsage('audio',a.duration);tell('Podés responder hablando o escribiendo.');stopVoice()};
  a.onerror=()=>{if(token===speechToken)tell('El audio no se pudo reproducir. Podés leer el texto.')};
  await a.play();if(token===speechToken)tell(fallbackFrom?'Fish rechazó la referencia de voz configurada. Para continuar, se está usando otra voz. Podés revisarla en Administración.':'El asistente está hablando. Tocá la imagen para repetir.');
 }catch(e){
  if(token!==speechToken)return;
  console.warn('Voz:',e.message);
  tell('No se pudo reproducir Fish. Podés leer el texto o tocar la imagen para reintentar.');
  if(!/play|abort/i.test(e.message))nativeVoice(text);
 }
}
async function reportUsage(kind,seconds){if(!Number.isFinite(seconds)||seconds<=0)return;try{await api('/api/student/usage',json('POST',{kind,seconds:Math.min(seconds,180)}))}catch{}}
function setBusy(v){busy=v;$('micButton').disabled=v;$('keyboardButton').disabled=v;$('textForm').querySelector('button').disabled=v}
function showComplete(){const done=session?.stage==='done';$('complete').hidden=!done;$('micButton').hidden=done;$('keyboardButton').hidden=done;$('textForm').hidden=true}
let pendingAnswer='',pendingLogged=false;
async function sendAnswer(message,retrying=false){
 message=String(message||'').trim();if(!message||busy)return;
 stopVoice();setBusy(true);tell('Consultando a Gemini…');
 if(!retrying){addLog('user',message);pendingLogged=true}
 pendingAnswer=message;$('retryPanel').hidden=true;$('textForm').hidden=true;
 try{
  const data=await api('/api/student/chat',json('POST',{message}));
  pendingAnswer='';pendingLogged=false;$('retryPanel').hidden=true;$('answer').value='';
  session.stage=data.stage;session.reviewed=data.reviewed;session.cv=data.cv;
  session.history.push({role:'user',text:message},{role:'assistant',text:data.reply});
  updateSubtitle(data.reply);
  if(data.download){
   showComplete();const anchor=document.createElement('a');anchor.href='/api/student/pdf';anchor.download='Mi-CV.pdf';
   document.body.append(anchor);anchor.click();anchor.remove();tell('CV generado. Si no se descarga automáticamente, tocá «Descargar mi CV».');
  }else tell('Podés continuar hablando o escribiendo.');
  speak(data.reply);
 }catch(e){
  const friendly=e.message||'No se pudo conectar con Gemini.';
  tell('No se pudo obtener una respuesta, pero conservamos lo que dijiste.');
  $('retryMessage').textContent=friendly+' Tu respuesta sigue disponible para reintentar o modificar.';
  $('retryPanel').hidden=false;
  $('answer').value=message;
  $('textForm').hidden=false;
  $('answer').focus({preventScroll:true});
 }finally{setBusy(false)}
}
function inputMode(){if(session?.stage==='done')return;const form=$('textForm');form.hidden=!form.hidden;if(!form.hidden){$('answer').focus();tell('Escribí tu respuesta y tocá Enviar.')}else tell('Podés usar el micrófono.')}

function finishMic(id){
 if(id!==micSessionId)return;
 const message=micText.trim();
 micSessionId++;micActive=false;listening=false;
 clearTimeout(micSilenceTimer);micSilenceTimer=null;
 $('micButton').classList.remove('recording');
 $('micButton').setAttribute('aria-pressed','false');
 $('micButton').setAttribute('aria-label','Hablar con el micrófono');
 reportUsage('mic',(Date.now()-micStart)/1000);
 subtitle.textContent=lastPrompt||config.introText;
 if(message){sendAnswer(message)}
 else tell(micError||'No escuché tu respuesta. Tocá otra vez para hablar o usá el teclado.');
}
function stopMic(){
 if(!micActive)return;
 clearTimeout(micSilenceTimer);micSilenceTimer=null;
 tell('Terminando el dictado…');
 try{recognition?.stop()}catch{finishMic(micSessionId)}
}
function startListening(){
 if(busy||session?.stage==='done')return;
 if(micActive){stopMic();return}
 const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
 if(!SpeechRecognition){$('textForm').hidden=false;$('answer').focus();tell('Tu navegador no admite dictado. Podés usar el teclado.');return}
 stopVoice();micText='';micError='';
 clearTimeout(micSilenceTimer);micSilenceTimer=null;
 const id=++micSessionId, r=new SpeechRecognition();recognition=r;
 r.lang=config?.microphone?.language||'es-AR';
 r.continuous=true;r.interimResults=true;r.maxAlternatives=1;
 micActive=true;listening=true;micStart=Date.now();
 $('micButton').classList.add('recording');
 $('micButton').setAttribute('aria-pressed','true');
 $('micButton').setAttribute('aria-label','Detener micrófono y enviar respuesta');
 tell('Te escucho. Tocá de nuevo para terminar, o esperá al detectar una pausa.');
 r.onresult=e=>{
  if(id!==micSessionId)return;
  let collected='';
  for(let i=0;i<e.results.length;i++)collected+=e.results[i][0].transcript+' ';
  micText=collected.trim();
  if(micText){
   subtitle.textContent=micText;
   tell('Escuchando… Al dejar de hablar o tocar el micrófono, envío tu respuesta.');
   clearTimeout(micSilenceTimer);
   micSilenceTimer=setTimeout(()=>{if(id===micSessionId)stopMic()},Number(config?.microphone?.silenceMs)||2200);
  }
 };
 r.onerror=e=>{
  if(id!==micSessionId)return;
  const messages={'not-allowed':'Permiso de micrófono denegado. Revisá los permisos del navegador.','audio-capture':'No se detectó un micrófono.','network':'No se pudo conectar al reconocimiento de voz. Probá el teclado.','no-speech':'No escuché tu voz. Tocá para intentar de nuevo.'};
  micError=messages[e.error]||'No pude reconocer la voz ('+e.error+'). Probá con el teclado.';
 };
 r.onend=()=>{if(id===micSessionId)finishMic(id)};
 try{r.start()}catch{micError='No pude activar el micrófono. Probá otra vez o usá el teclado.';finishMic(id)}
}
async function loadStudent(){config=await api('/api/bootstrap');session=await api('/api/student/session');$('appTitle').textContent=config.title;document.title=config.title;$('duration').textContent='Unos '+config.durationMinutes+' minutos';loginView.hidden=true;studentView.hidden=false;$('conversation').replaceChildren();for(const h of session.history||[])addLog(h.role,h.text);const text=session.lastAssistant||config.introText;updateSubtitle(text,!(session.history||[]).length);showComplete();preloadSprites();applyAppearance();animate();if(session.stage!=='done'){tell('Tocá el micrófono para hablar, o el teclado para escribir.');speak(text)}else tell('Tu CV está listo para descargar.')}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginError').textContent='';try{await api('/api/login',json('POST',{role:'student',password:$('accessKey').value}));await loadStudent()}catch(err){$('loginError').textContent=err.message}});
$('textForm').addEventListener('submit',e=>{e.preventDefault();sendAnswer($('answer').value)});
$('retryButton').addEventListener('click',()=>sendAnswer(pendingAnswer||$('answer').value,true));
$('keyboardButton').addEventListener('click',inputMode);
$('micButton').addEventListener('click',startListening);
$('avatarButton').addEventListener('click',()=>{if(!busy){const t=lastPrompt||config?.introText;if(t)speak(t)}});
$('restartButton').addEventListener('click',async()=>{if(!confirm('¿Querés empezar una nueva entrevista? Se borrarán los datos y el PDF de esta entrevista; descargalo antes si querés conservarlo.'))return;await api('/api/student/reset',{method:'POST'});await loadStudent()});
api('/api/me?role=student').then(me=>{if(me.role==='student')loadStudent()}).catch(()=>{});
