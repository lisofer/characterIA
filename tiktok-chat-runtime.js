/* TikTok LIVE: visor privado de comentarios, conexión e indicadores de actividad. */
(function(){
 'use strict';
 // Detección independiente de la UI: avisa una sola vez al finalizar un regalo
 // o una racha. Las actualizaciones intermedias solo actualizan la alerta visual.
 function createGiftTracker(now=()=>Date.now()){
  let session=null,seen=new Map(),notified=new Set(),ready=false;
  function consume(state,armed=false){
   const id=[state?.username||'',state?.roomId||'',state?.connectedAt||0].join('|');
   if(id!==session){session=id;seen.clear();notified.clear();ready=false}
   const gifts=(Array.isArray(state?.events)?state.events:[]).filter(x=>x?.kind==='gift');
   const changes=[],completed=[];
   if(!ready&&!armed){
    for(const gift of gifts){
     seen.set(gift.id,{count:gift.count,pending:gift.pending,at:gift.at});
     if(!gift.pending)notified.add(gift.id); // No anunciar regalos anteriores al abrir el panel.
    }
    ready=true;return {changes,completed};
   }
   ready=true;
   const currentTime=now();
   for(const gift of gifts){
    const prev=seen.get(gift.id);
    const updated=!prev||prev.count!==gift.count||prev.pending!==gift.pending;
    if(updated&&(!gift.at||currentTime-gift.at<12000))changes.push(gift);
    seen.set(gift.id,{count:gift.count,pending:gift.pending,at:gift.at});
    // La IA futura recibirá una sola señal por regalo, con la cantidad final.
    // Algunas rachas no mandan repeatEnd: después de 6 s sin cambios cerramos.
    if(!notified.has(gift.id)&&(!gift.pending||currentTime-Number(gift.at||currentTime)>=6000)){
     notified.add(gift.id);
     if(!gift.at||currentTime-gift.at<20000)completed.push(gift);
    }
   }
   const ids=new Set(gifts.map(g=>g.id));
   for(const key of seen.keys())if(!ids.has(key)){seen.delete(key);notified.delete(key)}
   return {changes,completed};
  }
  function reset(){session=null;seen.clear();notified.clear();ready=false}
  return {consume,reset};
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={createGiftTracker};
 if(typeof document==='undefined')return;
 const $=id=>document.getElementById(id);
 const GLOBAL='persona-studio-global-v3',DEFAULT_USER='peleasfalopa';
 const C={status:'idle',username:'',pending:false,renderKey:'',polling:false,edited:false,armed:false,lastGift:null};
 const giftTracker=createGiftTracker();
 const giftCallbacks=new Set();
 let hideGiftTimeout=null;
 function displayGift(gift){
  const box=$('ttChatGiftAlert');
  if(!box)return;
  const name=String(gift.name||gift.username||'Espectador').slice(0,50);
  const giftName=/^rose$/i.test(gift.giftName||'')?'Rosa':String(gift.giftName||'Regalo').slice(0,70);
  const qty=Number(gift.count)>1?' ×'+gift.count:'';
  box.textContent=(gift.emoji||'🎁')+' '+name+' envió '+giftName+qty;
  box.hidden=false;
  if(hideGiftTimeout!==null)clearTimeout(hideGiftTimeout);
  hideGiftTimeout=setTimeout(()=>{box.hidden=true;hideGiftTimeout=null},8500);
 }
 function emitGift(gift,state){
  const detail={id:gift.id,username:gift.username||'',name:gift.name||gift.username||'Espectador',
    giftId:gift.giftId||'',giftName:gift.giftName||'Regalo',
    count:Number(gift.count)||1,emoji:gift.emoji||'🎁',at:gift.at||Date.now(),
    roomId:state.roomId||'',broadcaster:state.username||''};
  C.lastGift={...detail};
  window.dispatchEvent(new CustomEvent('persona:tiktok-gift',{detail:{...detail}}));
  for(const fn of giftCallbacks)try{fn({...detail})}catch(error){console.warn('Receptor de regalos:',error)}
 }
 function processGifts(state){
  if(C.pending||(state.status!=='connected'&&state.status!=='connecting'))return;
  const batch=giftTracker.consume(state,C.armed);
  for(const gift of batch.changes)displayGift(gift);
  for(const gift of batch.completed)emitGift(gift,state);
 }
 function stored(){
  try{return String(JSON.parse(localStorage.getItem(GLOBAL)||'{}')?.tiktokChat?.username||DEFAULT_USER)}
  catch{return DEFAULT_USER}
 }
 function saveName(name){
  try{
   const state=JSON.parse(localStorage.getItem(GLOBAL)||'{}')||{};
   state.tiktokChat={username:name};
   localStorage.setItem(GLOBAL,JSON.stringify(state));
   window.PERSONA_CLOUD?.schedule?.();
  }catch{}
 }
 async function request(path,opts={}){
  const r=await fetch('/api/tiktok/chat'+path,{credentials:'same-origin',...opts});
  const data=await r.json();
  if(!r.ok)throw Error(data?.error||'TikTok no respondió.');
  return data;
 }
 const givenName=()=>String($('ttChatUser').value||'').trim().replace(/^@/,'');
 function updateButton(){
  const changed=C.username&&C.username.toLowerCase()!==givenName().toLowerCase();
  const connected=['connecting','connected'].includes(C.status);
  const button=$('ttChatConnect');
  button.textContent=changed?'↪':connected?'■':'▶';
  button.title=changed?'Cambiar al LIVE de @'+givenName():connected?'Desconectar chat':'Conectar al LIVE';
  button.setAttribute('aria-label',button.title);
  button.disabled=C.pending;
  $('ttChatRetry').disabled=C.pending;
 }
 function statusText(s){
  if(s.status==='connected')return '● @'+s.username;
  if(s.status==='connecting')return '◌ Conectando a @'+s.username;
  if(s.status==='ended')return 'LIVE finalizado';
  if(s.status==='disconnected')return 'Conexión perdida';
  if(s.status==='error')return 'Error de conexión';
  return '● Desconectado';
 }
 function textLine(name,body,isGift=false,pending=false){
  const div=document.createElement('div');div.className='tt-chat-line'+(isGift?' gift':'')+(pending?' streak':'');
  const strong=document.createElement('strong');strong.textContent=name;
  const content=document.createElement('span');content.textContent=body;
  div.append(strong,content);return div;
 }
 function paint(state){
  if(!state)return;
  C.status=state.status||'idle';C.username=state.username||'';
  $('ttChatStatus').textContent=statusText(state);
  $('ttChatStatus').dataset.state=state.warning?'warning':C.status;
  if(state.username&&!C.edited&&document.activeElement!==$('ttChatUser'))
   $('ttChatUser').value='@'+state.username;
  updateButton();
  const diag=$('ttChatDiagnostics');
  const bits=[];
  if(state.roomId)bits.push('Sala #'+state.roomId);
  if(state.status==='connected'){
   bits.push(state.socketConnected?'WebSocket abierto':'WebSocket sin confirmar');
   bits.push((state.wsFrames||0)+' paquetes');
   bits.push((state.decodedEvents||0)+' eventos');
   bits.push((state.chatEvents||0)+' chats');
   bits.push('🎁 '+(state.giftEvents||0)+' regalos');
   bits.push('gift '+(state.giftSignals||0)+' / datos '+(state.giftDecoded||0));
  }
  processGifts(state);
  diag.textContent=bits.join(' · ');
  diag.hidden=!bits.length;
  const giftDebug=$('ttChatGiftDebug');
  const seen=(state.giftSignals||0)+(state.giftDecoded||0);
  if(giftDebug){
   const methods=Object.entries(state.methods||{}).filter(([key])=>/gift|chat/i.test(key))
    .map(([key,n])=>key+': '+n).slice(-5).join(' · ');
   giftDebug.textContent=state.status!=='connected'?'Conectá primero para probar los regalos reales.':
    (state.giftEvents>0?'El servidor recibe regalos correctamente.':
     seen?'Llegaron eventos de regalo, pero no se registraron. Revisar formato.':
      'TikTok todavía no envió ningún evento de regalo a este conector.')+
     (methods?' · '+methods:'');
  }
  const latest=(Array.isArray(state.events)?state.events:state.comments||[]).slice(-45);
  const note=state.warning||(
   state.status==='connecting'?'Conectando con el LIVE de @'+state.username+'…':
   state.status==='connected'?'Conectado a @'+state.username+'. Esperando comentarios nuevos…':
   state.status==='idle'?'Elegí el @usuario que está EN VIVO y tocá ▶.':
   'No hay mensajes. Reconectá para reintentar.');
  const key=state.username+'|'+state.status+'|'+(state.warning||'')+'|'+latest.map(x=>x.id+':'+(x.count||'')+':'+(x.pending||'')).join('|');
  if(key!==C.renderKey){
   const list=$('ttChatMessages');
   const pinned=list.scrollHeight-list.scrollTop-list.clientHeight<32||!C.renderKey;
   list.replaceChildren();
   if(!latest.length)list.append(textLine('TikTok LIVE',note));
   else for(const item of latest){
    const isGift=item.kind==='gift';
    const handle=String(item.username||'').trim();
    const nickname=String(item.name||'').trim();
    const name=handle&&handle.toLowerCase()!=='espectador'?
      (nickname&&nickname!==handle?nickname+' (@'+handle+')':'@'+handle):
      (nickname||'Espectador');
    if(!isGift){list.append(textLine(name,item.text||''));continue}
    const giftName=/^rose$/i.test(item.giftName||'')?'Rosa':String(item.giftName||'Regalo');
    const count=item.count>1?' ×'+item.count:'';
    const msg=(item.emoji||'🎁')+' '+(item.pending?'está enviando ':'envió ')+giftName+count;
    list.append(textLine(name,msg,true,Boolean(item.pending)));
   }
   if(pinned)list.scrollTop=list.scrollHeight;
   C.renderKey=key;
  }
  const error=state.error||state.warning||'';
  $('ttChatError').textContent=error;
 }
 async function poll(){
  if(C.polling)return; // Seguimos leyendo regalos aunque el panel quede en segundo plano.
  C.polling=true;
  try{paint(await request(''))}
  catch(e){$('ttChatError').textContent='No se puede consultar el chat: '+e.message}
  finally{C.polling=false}
 }
 async function connect(force=false){
  if(C.pending)return;
  const name=givenName();
  if(!/^[a-zA-Z0-9._]{2,30}$/.test(name)){
   $('ttChatError').textContent='Poné el @usuario de la cuenta que está transmitiendo (sin enlaces).';
   $('ttChatUserRow').hidden=false;$('ttChatUser').focus();return;
  }
  C.pending=true;C.armed=true;C.lastGift=null;giftTracker.reset();updateButton();$('ttChatError').textContent='';
  try{
   const data=await request('/connect',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:name,force})});
   saveName(name);C.edited=false;C.renderKey='';paint(data);
  }catch(e){$('ttChatError').textContent=e.message}
  finally{C.pending=false;updateButton()}
 }
 async function disconnect(){
  if(C.pending)return;
  C.pending=true;C.armed=false;C.lastGift=null;giftTracker.reset();$('ttChatGiftAlert').hidden=true;updateButton();
  try{C.renderKey='';paint(await request('/disconnect',{method:'POST'}))}
  catch(e){$('ttChatError').textContent=e.message}
  finally{C.pending=false;updateButton()}
 }
 function toggle(){
  const different=C.username&&givenName().toLowerCase()!==C.username.toLowerCase();
  if(!different&&['connected','connecting'].includes(C.status))return disconnect();
  return connect();
 }
 function init(){
  if(!$('ttChatPanel'))return;
  $('ttChatUser').value='@'+stored().replace(/^@/,'');
  $('ttChatUser').addEventListener('input',()=>{C.edited=true;updateButton()});
  $('ttChatConnect').addEventListener('click',toggle);
  $('ttChatRetry').addEventListener('click',()=>connect(true));
  $('ttChatTestGift').addEventListener('click',()=>{
   displayGift({name:'Juanma',giftName:'Rosa',emoji:'🌹',count:1});
   $('ttChatGiftDebug').textContent='Prueba visual: el recuadro funciona. No llegó un regalo real y no se enviará ningún agradecimiento.';
  });
  $('ttChatSettings').addEventListener('click',()=>{
   const row=$('ttChatUserRow');
   row.hidden=!row.hidden;
   if(!row.hidden)$('ttChatUser').focus();
  });
  $('ttChatUser').addEventListener('keydown',e=>{
   if(e.key==='Enter'){e.preventDefault();connect(true)}
  });
  updateButton();poll();setInterval(poll,1600);
  window.addEventListener('focus',poll);
  window.PERSONA_TIKTOK_CHAT={
   refresh:()=>{if(C.status==='idle'&&!C.edited)$('ttChatUser').value='@'+stored().replace(/^@/,'');poll()},
   onGift:callback=>{
    if(typeof callback!=='function')return ()=>{};
    giftCallbacks.add(callback);return ()=>giftCallbacks.delete(callback);
   },
   lastGift:()=>C.lastGift?{...C.lastGift}:null
  };
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
 else init();
})();
