/* Chat público de TikTok LIVE, visible solo en el panel del moderador. */
(function(){
 'use strict';
 if(typeof document==='undefined')return;
 const $=id=>document.getElementById(id);
 const GLOBAL='persona-studio-global-v3';
 const DEFAULT_USER='peleasfalopa';
 const C={status:'idle',username:'',id:'',pending:false,renderKey:'',polling:false};
 function stored(){
  try{
   const saved=JSON.parse(localStorage.getItem(GLOBAL)||'{}');
   return String(saved?.tiktokChat?.username||DEFAULT_USER);
  }catch{return DEFAULT_USER}
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
  const response=await r.json();
  if(!r.ok)throw Error(response?.error||'TikTok no respondió');
  return response;
 }
 function statusText(s){
  if(s.status==='connected')return '● En vivo · @'+s.username;
  if(s.status==='connecting')return '◌ Conectando a TikTok…';
  if(s.status==='ended')return 'LIVE finalizado · Reconectar';
  if(s.status==='disconnected')return 'Desconectado · Reconectar';
  if(s.status==='error')return 'No conectado · Reintentar';
  return '● Desconectado';
 }
 function textLine(name,body){
  const line=document.createElement('div');line.className='tt-chat-line';
  const user=document.createElement('strong');user.textContent=name;
  const message=document.createElement('span');message.textContent=body;
  line.append(user,message);return line;
 }
 function paint(state){
  if(!state)return;
  C.status=state.status||'idle';C.username=state.username||'';
  const status=$('ttChatStatus');
  status.textContent=statusText(state);
  status.dataset.state=C.status;
  const on=['connected','connecting'].includes(C.status);
  $('ttChatConnect').textContent=on?'■':'▶';
  $('ttChatConnect').title=on?'Desconectar chat':'Conectar chat';
  $('ttChatConnect').setAttribute('aria-label',on?'Desconectar chat':'Conectar chat');
  $('ttChatConnect').disabled=C.pending;
  if(state.username&&document.activeElement!==$('ttChatUser'))$('ttChatUser').value='@'+state.username;
  const latest=(state.comments||[]).slice(-45);
  const key=state.username+'|'+latest.length+'|'+(latest[0]?.id||'')+'|'+(latest.at(-1)?.id||'');
  if(key!==C.renderKey){
   const list=$('ttChatMessages');
   const pinned=list.scrollHeight-list.scrollTop-list.clientHeight<32||!C.renderKey;
   list.replaceChildren();
   if(!latest.length)list.append(textLine('TikTok LIVE',
     on?'Esperando comentarios del público…':'Conectá para ver lo que escriben los espectadores.'));
   else for(const item of latest)list.append(textLine('@'+(item.username||'usuario'),item.text||''));
   if(pinned)list.scrollTop=list.scrollHeight;
   C.renderKey=key;
  }
  const error=$('ttChatError');
  error.textContent=['error','disconnected','ended'].includes(state.status)?String(state.error||'').slice(0,155):'';
 }
 async function poll(){
  if(C.polling||document.hidden)return;
  C.polling=true;
  try{paint(await request(''))}
  catch(e){$('ttChatError').textContent='No se puede consultar el chat: '+e.message}
  finally{C.polling=false}
 }
 async function toggle(){
  if(C.pending)return;
  const input=$('ttChatUser');
  const on=['connecting','connected'].includes(C.status);
  const name=input.value.trim().replace(/^@/,'');
  if(!on&&!/^[a-zA-Z0-9._]{2,30}$/.test(name)){
   $('ttChatError').textContent='Escribí el @usuario de TikTok, sin espacios.';input.focus();return;
  }
  C.pending=true;$('ttChatConnect').disabled=true;$('ttChatError').textContent='';
  try{
   const response=on?await request('/disconnect',{method:'POST'}):
     await request('/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name})});
   if(!on)saveName(name);
   C.renderKey='';paint(response);
  }catch(e){$('ttChatError').textContent=e.message}
  finally{C.pending=false;$('ttChatConnect').disabled=false}
 }
 function init(){
  if(!$('ttChatPanel'))return;
  $('ttChatUser').value='@'+stored().replace(/^@/,'');
  $('ttChatConnect').addEventListener('click',toggle);
  $('ttChatSettings').addEventListener('click',()=>{
   const box=$('ttChatUserRow');
   box.hidden=!box.hidden;
   if(!box.hidden)$('ttChatUser').focus();
  });
  $('ttChatUser').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();toggle()}});
  poll();setInterval(poll,1600);
  window.addEventListener('focus',poll);
  window.PERSONA_TIKTOK_CHAT={refresh:()=>{if(C.status==='idle')$('ttChatUser').value='@'+stored().replace(/^@/,'');poll()}};
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
