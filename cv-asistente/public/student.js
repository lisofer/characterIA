'use strict';
const $=id=>document.getElementById(id);
const loginView=$('loginView'),studentView=$('studentView'),subtitle=$('subtitle'),statusEl=$('status');
const json=(method,body)=>({method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
async function api(path,options={}){
 const r=await fetch(path,{credentials:'same-origin',...options});
 const type=r.headers.get('content-type')||'';
 const body=type.includes('application/json')?await r.json().catch(()=>({})):{};
 if(!r.ok)throw Error(body.error||'Error HTTP '+r.status);
 return body;
}
let config=null,session=null,mode='call',busy=false,ended=false;
let voiceAudio=null,voiceToken=0,voiceKind='',speechActive=false,speechPlan=null,lastAssistant='',lastCaption='',avatarLoop=0,blinkUntil=0;
let recognition=null,recognitionSeq=0,recognitionTimer=null,holdActive=false,micStarted=0,micDraft='',holdAccumulated='',lastSnapshot='',silenceTimer=null,recognitionStopped=false,stoppingForRequest=false,restartCount=0;
let requestController=null,requestVersion=0,pendingAnswer='',hasSpeechError=false,audioPermissionBlocked=false,callReady=false;
const sprites=[];
function tell(t){statusEl.textContent=t||''}
function setSubtitle(text){
 text=String(text||'');
 if(text===lastCaption)return;
 lastCaption=text;subtitle.textContent=text||' ';
}
function addLog(role,text){
 const div=document.createElement('div');div.className='log-entry'+(role==='user'?' you':'');
 div.textContent=(role==='user'?'Vos: ':'Asistente: ')+text;
 const root=$('conversation');root.append(div);if(root.children.length>40)root.firstChild.remove();
}
function imageState(i){
 const img=$('avatar'),url=config?.images?.[String(i)]||config?.images?.['0'];
 if(!url){img.hidden=true;$('avatarPlaceholder').hidden=false;return}
 const absolute=new URL(url,location.href).href;
 if(img.src!==absolute)img.src=absolute;
 img.hidden=false;$('avatarPlaceholder').hidden=true;
}
function preloadSprites(){
 sprites.length=0;
 for(let i=0;i<8;i++){const url=config?.images?.[String(i)];if(url){const image=new Image();image.src=url;sprites.push(image)}}
}
function applyAppearance(){
 const el=$('avatarButton'),s=config?.appearance||{};
 el.style.setProperty('--sprite-scale',String(s.scale??1));
 el.style.setProperty('--sprite-offset-x',String(s.offsetX??0)+'%');
 el.style.setProperty('--sprite-offset-y',String(s.offsetY??0)+'%');
}
function animate(){
 cancelAnimationFrame(avatarLoop);
 let nextBlink=performance.now()+2400;
 const loop=()=>{
  const now=performance.now();
  const talking=speechActive&&!!voiceAudio&&!voiceAudio.paused&&!voiceAudio.ended;
  const elapsed=talking?(voiceAudio.currentTime||0)*1000:0;
  const total=talking?(voiceAudio.duration||0)*1000:0;
  const mouth=talking&&window.PersonaLipSync?window.PersonaLipSync.pose(speechPlan,elapsed,total,config?.lipSync||{}):0;
  if(now>=nextBlink){blinkUntil=now+135;nextBlink=now+Number(config?.lipSync?.blinkInterval||3500)+Math.random()*750}
  const blinking=config?.lipSync?.blink!==false&&now<blinkUntil;
  imageState(mouth+(blinking?1:0));
  $('fallbackMouth').textContent=talking?(mouth===4?'O':mouth===6?'—':mouth?'◯':'—'):'ᴗ';
  if(talking&&window.PersonaLipSync){
   const current=window.PersonaLipSync.caption(speechPlan,elapsed,total);
   if(current)setSubtitle(current);
  }
  avatarLoop=requestAnimationFrame(loop);
 };
 avatarLoop=requestAnimationFrame(loop);
}
function stopVoice(){
 voiceToken++;
 speechActive=false;speechPlan=null;
 if(voiceAudio){
  const old=voiceAudio;voiceAudio=null;
  old.onplaying=null;old.onended=null;old.onerror=null;
  old.pause();old.removeAttribute('src');old.load();
 }
 try{speechSynthesis.cancel()}catch{}
}
function nativeVoice(text,token){
 if(!('speechSynthesis' in window))return;
 const utterance=new SpeechSynthesisUtterance(text);
 utterance.lang='es-AR';utterance.rate=1;
 const plan=window.PersonaLipSync?.build(text);
 const words=plan?.entries||[];
 utterance.onboundary=e=>{
  if(token!==voiceToken)return;
  const i=words.findIndex(x=>e.charIndex>=x.index&&e.charIndex<=x.endIndex);
  if(i>=0)setSubtitle(window.PersonaLipSync?.caption(plan,words[i].start,plan.total)||text.slice(e.charIndex,e.charIndex+70));
 };
 utterance.onstart=()=>{if(token===voiceToken){speechActive=true;tell('El asistente está hablando · voz del dispositivo')}}
 utterance.onend=()=>{if(token===voiceToken){speechActive=false;afterSpeaking()}};
 utterance.onerror=()=>{if(token===voiceToken){speechActive=false;tell('El texto está disponible en el historial.')}} ;
 setSubtitle((window.PersonaLipSync?.captions(plan)?.[0]?.text)||text.slice(0,65));
 speechSynthesis.speak(utterance);
}
function afterSpeaking(){
 if(mode==='ended'){tell('La llamada terminó.');return}
 if(session?.stage==='done'){tell('Tu CV está listo para descargar.');return}
 if(mode==='call')tell('Te escucho · hablá cuando quieras');
 else if(mode==='keyboard')tell('Podés responder escribiendo. El asistente seguirá hablando.');
 else tell('Mantené pulsado el micrófono para enviar un audio.');
}
function speak(text,kind='last'){
 if(!text)return;
 stopVoice();
 const token=voiceToken;
 speechPlan=window.PersonaLipSync?.build(text)||null;
 voiceKind=kind;
 setSubtitle('');
 tell('Preparando la voz del asistente…');
 const audio=new Audio();
 voiceAudio=audio;audio.preload='auto';
 audio.onplaying=()=>{
  if(token!==voiceToken)return;
  speechActive=true;audioPermissionBlocked=false;
  $('activateAudioButton').hidden=true;
  tell(mode==='ended'?'Despidiéndose…':'El asistente está hablando. Podés interrumpirlo.');
 };
 audio.onended=()=>{
  if(token!==voiceToken)return;
  const duration=audio.duration;
  if(Number.isFinite(duration))reportUsage('audio',duration);
  speechActive=false;afterSpeaking();
 };
 const fail=()=>{
  if(token!==voiceToken||audio.dataset.fallback==='1')return;
  audio.dataset.fallback='1';speechActive=false;
  nativeVoice(text,token);
 };
 audio.onerror=fail;
 audio.src='/api/tts-stream?kind='+encodeURIComponent(kind)+'&v='+Date.now();
 audio.play().catch(e=>{
  if(token!==voiceToken)return;
  if(e.name==='NotAllowedError'){
   audioPermissionBlocked=true;
   $('activateAudioButton').hidden=false;
   tell('El navegador bloqueó el sonido automático. Tocá «Activar sonido».');
   setSubtitle('Tocá «Activar sonido» para escuchar al asistente');
  }else fail();
 });
}
function resumeSound(){
 const a=voiceAudio;
 if(a&&audioPermissionBlocked){
  a.play().then(()=>{$('activateAudioButton').hidden=true;audioPermissionBlocked=false}).catch(()=>nativeVoice(lastAssistant,voiceToken));
 }else if(lastAssistant)speak(lastAssistant,session?.history?.length?'last':'intro');
}
async function reportUsage(kind,seconds){
 if(!Number.isFinite(seconds)||seconds<=0)return;
 try{await api('/api/student/usage',json('POST',{kind,seconds:Math.min(seconds,180)}))}catch{}
}
function ui(){
 const isCall=mode==='call',isKeyboard=mode==='keyboard',isAudio=mode==='audio',isEnded=mode==='ended';
 $('callModeTag').textContent=isEnded?'LLAMADA FINALIZADA':isCall?'LLAMADA EN CURSO':isKeyboard?'MODO TECLADO':'MODO AUDIO';
 $('callStateDot').classList.toggle('is-ended',isEnded);
 $('hangupButton').disabled=isEnded;
 $('micButton').disabled=busy||isEnded||session?.stage==='done';
 $('keyboardButton').disabled=isEnded||session?.stage==='done';
 $('micButton').classList.toggle('is-recording',holdActive);
 $('micButton').setAttribute('aria-pressed',String(holdActive));
 $('keyboardButton').classList.toggle('is-selected',isKeyboard);
 $('textForm').hidden=!isKeyboard||isEnded||session?.stage==='done';
 $('returnCallButton').hidden=(isCall&&!hasSpeechError)||isEnded||session?.stage==='done';
 $('callEnded').hidden=!isEnded||session?.stage==='done';
 $('complete').hidden=session?.stage!=='done';
 $('callActions').hidden=session?.stage==='done'||isEnded;
 if(session?.stage==='done')$('returnCallButton').hidden=true;
}
function clearRecognitionTimer(){clearTimeout(silenceTimer);silenceTimer=null}
function cancelRecognition(){
 clearRecognitionTimer();clearTimeout(recognitionTimer);
 const previous=recognition;recognition=null;
 recognitionSeq++;micDraft='';lastSnapshot='';recognitionStopped=true;
 if(previous){previous.onresult=null;previous.onend=null;previous.onerror=null;
  try{previous.abort()}catch{}
 }
}
function cleanTranscript(raw){return window.SpeechInput?.dedupe(raw)||String(raw||'').trim().slice(0,850)}
function echoesAssistant(t){
 if(!speechActive||!lastAssistant)return false;
 const norm=s=>String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9áéíóúñ\s]/g,' ').replace(/\s+/g,' ').trim();
 const uttered=norm(t),reply=norm(lastAssistant);
 if(!uttered||!reply)return false;
 // Speaker leakage may produce short fragments of the assistant's own voice.
 if(uttered.length<=40&&reply.includes(uttered))return true;
 const spoken=uttered.split(' ').filter(w=>w.length>2);
 const inReply=spoken.filter(w=>reply.includes(w)).length;
 return spoken.length>=2&&inReply/spoken.length>=.85;
}
function finishRecognition(seq,send=true){
 if(seq!==recognitionSeq)return;
 const answer=cleanTranscript(mode==='audio'?[holdAccumulated,micDraft].filter(Boolean).join(' '):micDraft);
 const elapsed=(Date.now()-micStarted)/1000;
 cancelRecognition();holdActive=false;holdAccumulated='';
 if(elapsed>0)reportUsage('mic',elapsed);
 ui();
 if(!send||mode==='ended'||session?.stage==='done')return;
 if(answer){restartCount=0;sendAnswer(answer);}
 else if(mode==='call'){
  if(!busy){tell('Te escucho · hablá cuando quieras');scheduleCallRestart();}
 }else{tell('No escuché una respuesta. Mantené apretado para intentar otra vez.')}
}
function scheduleCallRestart(){
 if(mode!=='call'||busy||ended||recognition||session?.stage==='done'||hasSpeechError)return;
 clearTimeout(recognitionTimer);
 recognitionTimer=setTimeout(()=>{if(mode==='call'&&!busy&&!recognition)startRecognition('call')},Math.min(1200,250+restartCount*110));
}
function startRecognition(source){
 if(busy||ended||session?.stage==='done'||recognition)return;
 if(!['call','audio'].includes(source)||mode!==source)return;
 const Engine=window.SpeechRecognition||window.webkitSpeechRecognition;
 if(!Engine){
  hasSpeechError=true;
  tell('Este navegador no admite escucha automática. Podés escribir tu respuesta.');
  $('returnCallButton').hidden=false;
  return;
 }
 const r=new Engine();
 recognition=r;recognitionStopped=false;micDraft='';lastSnapshot='';micStarted=Date.now();
 const seq=++recognitionSeq;
 r.lang=config?.microphone?.language||'es-AR';
 r.continuous=true;r.interimResults=true;r.maxAlternatives=1;
 r.onresult=event=>{
  if(seq!==recognitionSeq||mode!==source||busy)return;
  // Build one snapshot from the CURRENT recognition result list, replacing interim
  // alternatives rather than accumulating them with each onresult event.
  const snapshot=window.SpeechInput?.snapshot(event.results)||cleanTranscript(Array.from(event.results||[],x=>x?.[0]?.transcript||'').join(' '));
  if(!snapshot||snapshot===lastSnapshot)return;
  if(source==='call'&&echoesAssistant(snapshot))return;
  lastSnapshot=snapshot;micDraft=snapshot;
  if(source==='call'&&speechActive){stopVoice();tell('Te escucho, continuá…')}
  else tell(source==='call'?'Te escucho · hablá cuando quieras':'Grabando audio · soltá para enviar');
  if(source==='call'){
   clearRecognitionTimer();
   silenceTimer=setTimeout(()=>{
    if(seq!==recognitionSeq)return;
    try{recognition?.stop()}catch{finishRecognition(seq)}
   },Math.max(1000,Number(config?.microphone?.silenceMs)||2200));
  }
 };
 r.onerror=e=>{
  if(seq!==recognitionSeq)return;
  const errors={
   'not-allowed':'Permiso del micrófono denegado. Revisá los permisos de Chrome.',
   'service-not-allowed':'El navegador bloqueó el servicio de reconocimiento de voz.',
   'audio-capture':'No se detectó un micrófono.',
   network:'No se pudo conectar con el reconocimiento de voz. Podés escribir.',
   'no-speech':'No se detectó voz. Podés intentar otra vez.'
  };
  const message=errors[e.error]||'Hubo un problema con el micrófono ('+e.error+').';
  if(['not-allowed','service-not-allowed','audio-capture','network'].includes(e.error)){
   hasSpeechError=true;tell(message);$('returnCallButton').hidden=false;
  }
 };
 r.onend=()=>{
  if(seq!==recognitionSeq)return;
  const hadText=!!micDraft;
  if(source==='audio'&&holdActive&&!hasSpeechError){
   if(hadText)holdAccumulated=cleanTranscript([holdAccumulated,micDraft].filter(Boolean).join(' '));
   cancelRecognition();
   if(holdActive)setTimeout(()=>{if(holdActive&&mode==='audio'&&!recognition)startRecognition('audio')},130);
   return;
  }
  const canSend=source==='audio'?true:hadText;
  finishRecognition(seq,canSend);
  if(source==='call'&&!hadText){
   // Chrome puede cerrar reconocimiento durante silencios normales.
   // Seguimos escuchando con una pausa breve para cuidar batería.
   restartCount=Math.min(12,restartCount+1);
  }
 };
 try{r.start();
  if(source==='call')tell('Te escucho · hablá cuando quieras');
  else tell('Grabando audio · soltá para enviar');
 }catch(e){cancelRecognition();hasSpeechError=true;tell('Chrome necesita que habilites el micrófono. Tocá «Volver al modo llamada».');$('returnCallButton').hidden=false}
}
function switchMode(next){
 if(session?.stage==='done'||ended)return;
 cancelRecognition();
 mode=next;holdActive=false;holdAccumulated='';hasSpeechError=false;restartCount=0;
 ui();
 if(next==='keyboard'){$('answer').focus({preventScroll:true});tell('Escribí tu respuesta. El micrófono está apagado.')}
 else if(next==='audio')tell('Mantené pulsado el botón naranja para hablar. Al soltar, envío tu audio.');
 else if(next==='call'){tell('Te escucho · hablá cuando quieras');startRecognition('call')}
}
function beginHold(event){
 if(busy||ended||session?.stage==='done')return;
 if(event.type==='pointerdown'&&event.button!==0)return;
 if(event.cancelable)event.preventDefault();
 if(mode!=='audio')switchMode('audio');
 holdAccumulated='';holdActive=true;hasSpeechError=false;ui();
 if(event.pointerId!==undefined)try{$('micButton').setPointerCapture(event.pointerId)}catch{}
 if(speechActive)stopVoice();
 startRecognition('audio');
}
function endHold(event){
 if(!holdActive)return;
 if(event.cancelable)event.preventDefault();
 holdActive=false;
 const seq=recognitionSeq;
 if(recognition){tell('Procesando tu audio…');try{recognition.stop()}catch{finishRecognition(seq)}}
 else if(holdAccumulated){const answer=cleanTranscript(holdAccumulated);holdAccumulated='';if(answer)sendAnswer(answer);else{tell('No escuché una respuesta.');ui()}}
 else{tell('Tocá y mantené pulsado un momento para grabar.');ui()}
}
function cancelHold(){if(!holdActive)return;holdActive=false;holdAccumulated='';cancelRecognition();ui();tell('Se canceló el audio. Podés volver a grabarlo.')}
function beginHangup(){
 if(ended||session?.stage==='done')return;
 mode='ended';ended=true;
 cancelRecognition();stopVoice();
 requestVersion++;if(requestController){try{requestController.abort()}catch{}requestController=null}
 busy=false;pendingAnswer='';holdActive=false;
 $('retryPanel').hidden=true;
 ui();
 tell('Llamada finalizada');
 const goodbye=config?.farewellText||'¡Hasta luego! Gracias por conversar conmigo. ¡Nos vemos!';
 lastAssistant=goodbye;speak(goodbye,'farewell');
}
async function resumeCall(){
 ended=false;mode='call';busy=false;pendingAnswer='';hasSpeechError=false;restartCount=0;
 try{
  session=await api('/api/student/session');
  $('conversation').replaceChildren();for(const h of session.history||[])addLog(h.role,h.text);
 }catch(e){tell('No pude recuperar la entrevista: '+e.message);return}
 lastAssistant=(session.history||[]).length?(session.lastAssistant||config.introText):config.introText;
 ui();
 if(session.stage!=='done')startRecognition('call');
 if(session.stage==='done')tell('Tu currículum está listo para descargar.');
 else speak(lastAssistant,(session.history||[]).length?'last':'intro');
}
async function sendAnswer(message,retry=false){
 const value=cleanTranscript(message);
 if(!value||busy||ended||session?.stage==='done')return;
 cancelRecognition();stopVoice();
 busy=true;hasSpeechError=false;requestVersion++;const version=requestVersion;
 requestController=new AbortController();
 ui();
 if(!retry)addLog('user',value);
 pendingAnswer=value;$('retryPanel').hidden=true;
 tell('Pensando en tu respuesta…');
 const started=performance.now();
 try{
  const data=await api('/api/student/chat',{...json('POST',{message:value}),signal:requestController.signal});
  if(version!==requestVersion||ended)return;
  pendingAnswer='';$('retryPanel').hidden=true;$('answer').value='';
  session.stage=data.stage;session.reviewed=data.reviewed;session.cv=data.cv;
  session.history.push({role:'user',text:value},{role:'assistant',text:data.reply});
  lastAssistant=data.reply;addLog('assistant',data.reply);
  tell('Preparando la voz del asistente…');
  if(data.download){
   const link=document.createElement('a');link.href='/api/student/pdf';link.download='Mi-CV.pdf';document.body.append(link);link.click();link.remove();
   tell('CV generado. Podés descargarlo nuevamente.');
  }
  if(mode==='call'&&session.stage!=='done'&&!hasSpeechError)startRecognition('call');
  speak(data.reply,'last');
 }catch(e){
  if(version!==requestVersion||ended)return;
  if(e.name==='AbortError')return;
  $('retryMessage').textContent=(e.message||'No pude consultar a Gemini.')+' Conservé tu respuesta para reintentar.';
  $('retryPanel').hidden=false;
  $('answer').value=value;
  tell('Hubo un problema al enviar tu respuesta.');
 }finally{
  if(version===requestVersion){
   busy=false;requestController=null;ui();
   if(mode==='call'&&!recognition&&!ended&&session.stage!=='done'&&$('retryPanel').hidden)scheduleCallRestart();
  }
 }
}
function finishStudent(){
 ui();
 if(mode==='ended')tell('La llamada terminó.');
 else if(session.stage==='done')tell('CV terminado. Descargalo cuando quieras.');
}
async function loadStudent(){
 config=await api('/api/bootstrap');
 session=await api('/api/student/session');
 $('appTitle').textContent=config.title;document.title=config.title+' · Llamada';
 $('assistantLabel').textContent=(config.characterName||'Alex').toUpperCase()+' · ASISTENTE';
 $('duration').textContent='Unos '+config.durationMinutes+' minutos';
 loginView.hidden=true;studentView.hidden=false;
 $('conversation').replaceChildren();for(const h of session.history||[])addLog(h.role,h.text);
 mode='call';ended=false;busy=false;hasSpeechError=false;
 lastAssistant=(session.history||[]).length?(session.lastAssistant||config.introText):config.introText;
 preloadSprites();applyAppearance();animate();finishStudent();
 if(session.stage!=='done'){
  startRecognition('call');
  speak(lastAssistant,(session.history||[]).length?'last':'intro');
 }else{setSubtitle('¡Tu currículum está listo!');}
}
$('loginForm').addEventListener('submit',async e=>{
 e.preventDefault();$('loginError').textContent='';
 try{await api('/api/login',json('POST',{role:'student',password:$('accessKey').value}));await loadStudent()}
 catch(err){$('loginError').textContent=err.message}
});
$('textForm').addEventListener('submit',e=>{e.preventDefault();sendAnswer($('answer').value)});
$('retryButton').addEventListener('click',()=>sendAnswer(pendingAnswer||$('answer').value,true));
$('keyboardButton').addEventListener('click',()=>switchMode('keyboard'));
$('returnCallButton').addEventListener('click',()=>{if(ended){resumeCall();return}switchMode('call')});
$('hangupButton').addEventListener('click',beginHangup);
$('resumeButton').addEventListener('click',resumeCall);
$('activateAudioButton').addEventListener('click',resumeSound);
$('micButton').addEventListener('pointerdown',beginHold);
$('micButton').addEventListener('pointerup',endHold);
$('micButton').addEventListener('pointercancel',cancelHold);
$('micButton').addEventListener('lostpointercapture',()=>{if(holdActive)endHold({cancelable:false})});
$('micButton').addEventListener('contextmenu',e=>e.preventDefault());
$('micButton').addEventListener('keydown',e=>{if(e.repeat)return;if([' ','Enter'].includes(e.key)){e.preventDefault();beginHold(e)}});
$('micButton').addEventListener('keyup',e=>{if([' ','Enter'].includes(e.key)){e.preventDefault();endHold(e)}});
$('avatarButton').addEventListener('click',()=>{if(!busy&&!ended&&lastAssistant)speak(lastAssistant,session?.history?.length?'last':'intro')});
$('restartButton').addEventListener('click',async()=>{
 if(!confirm('¿Querés crear otro CV? Se borrarán los datos de esta entrevista.'))return;
 cancelRecognition();stopVoice();
 await api('/api/student/reset',{method:'POST'});await loadStudent();
});
document.addEventListener('visibilitychange',()=>{
 if(document.hidden){cancelRecognition();if(speechActive)stopVoice()}
 else if(mode==='call'&&!busy&&!ended&&session?.stage!=='done'&&!hasSpeechError)scheduleCallRestart();
});
api('/api/me?role=student').then(me=>{if(me.role==='student')loadStudent()}).catch(()=>{});
