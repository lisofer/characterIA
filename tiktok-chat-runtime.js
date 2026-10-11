/* TikTok LIVE: visor privado de comentarios, conexión e indicadores de actividad. */
(function(){
 'use strict';
 if(typeof document==='undefined')return;
 const $=id=>document.getElementById(id);
 const GLOBAL='persona-studio-global-v3',DEFAULT_USER='peleasfalopa';
 const C={status:'idle',username:'',pending:false,renderKey:'',polling:false,edited:false};
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
 function textLine(name,body){
  const div=document.createElement('div');div.className='tt-chat-line';
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
  }
  diag.textContent=bits.join(' · ');
  diag.hidden=!bits.length;
  const latest=(state.comments||[]).slice(-45);
  const note=state.warning||(
   state.status==='connecting'?'Conectando con el LIVE de @'+state.username+'…':
   state.status==='connected'?'Conectado a @'+state.username+'. Esperando comentarios nuevos…':
   state.status==='idle'?'Elegí el @usuario que está EN VIVO y tocá ▶.':
   'No hay mensajes. Reconectá para reintentar.');
  const key=state.username+'|'+state.status+'|'+(state.warning||'')+'|'+latest.length+'|'+
    (latest[0]?.id||'')+'|'+(latest.at(-1)?.id||'');
  if(key!==C.renderKey){
   const list=$('ttChatMessages');
   const pinned=list.scrollHeight-list.scrollTop-list.clientHeight<32||!C.renderKey;
   list.replaceChildren();
   if(!latest.length)list.append(textLine('TikTok LIVE',note));
   else for(const item of latest)list.append(textLine('@'+(item.username||'usuario'),item.text||''));
   if(pinned)list.scrollTop=list.scrollHeight;
   C.renderKey=key;
  }
  const error=state.error||state.warning||'';
  $('ttChatError').textContent=error;
 }
 async function poll(){
  if(C.polling||document.hidden)return;
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
  C.pending=true;updateButton();$('ttChatError').textContent='';
  try{
   const data=await request('/connect',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:name,force})});
   saveName(name);C.edited=false;C.renderKey='';paint(data);
  }catch(e){$('ttChatError').textContent=e.message}
  finally{C.pending=false;updateButton()}
 }
 async function disconnect(){
  if(C.pending)return;
  C.pending=true;updateButton();
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
  window.PERSONA_TIKTOK_CHAT={refresh:()=>{
   if(C.status==='idle'&&!C.edited)$('ttChatUser').value='@'+stored().replace(/^@/,'');
   poll();
  }};
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
 else init();
})();
