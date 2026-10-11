'use strict';
// Puente TikTok LIVE (no oficial). Solo lectura. Los controles son privados.
const MAX_COMMENTS=75;
function normalizeUsername(value){
 const input=String(value||'').trim().replace(/^@/,'');
 return /^[a-zA-Z0-9._]{2,30}$/.test(input)?input:null;
}
function normalizeComment(event,id,now=Date.now()){
 const source=event?.chatMessage||event?.data||event?.message||event;
 const text=String(source?.comment??source?.content??'').trim().slice(0,420);
 if(!text)return null;
 const user=source?.user||{};
 const uniqueId=String(user.uniqueId||source?.uniqueId||'espectador').slice(0,40);
 const nickname=String(user.nickname||user.nickName||source?.nickname||uniqueId).slice(0,50);
 return {id,username:uniqueId,name:nickname,text,at:now};
}
function createTikTokChat(options={}){
 const load=options.loadConnector||(()=>import('tiktok-live-connector'));
 const now=options.now||Date.now;
 let generation=0,active=null,nextId=0;
 let recentFingerprints=new Map();
 const fresh=()=>now();
 const data={username:'',status:'idle',error:'',roomId:null,comments:[],
  updatedAt:fresh(),connectedAt:0,lastEventAt:0,lastCommentAt:0,
  wsFrames:0,decodedEvents:0,chatEvents:0,socketConnected:false};
 function snapshot(){
  const age=data.status==='connected'&&data.connectedAt?Math.max(0,fresh()-data.connectedAt):0;
  let warning='';
  if(data.status==='connected'&&age>=14000&&data.comments.length===0){
   if(!data.wsFrames&&!data.decodedEvents&&!data.chatEvents)
    warning='El LIVE figura conectado, pero TikTok no está enviando datos. Revisá el @usuario y probá ↻.';
   else if(!data.chatEvents)
    warning='La conexión recibe datos, pero aún no llegaron comentarios. Probá escribir uno en el LIVE.';
  }
  return {...data,warning,comments:data.comments.slice()};
 }
 function stop(){
  generation++;
  const old=active;active=null;
  if(old)try{Promise.resolve(old.disconnect()).catch(()=>{})}catch{}
  recentFingerprints.clear();
  Object.assign(data,{username:'',status:'idle',error:'',roomId:null,comments:[],updatedAt:fresh(),
   connectedAt:0,lastEventAt:0,lastCommentAt:0,wsFrames:0,decodedEvents:0,chatEvents:0,socketConnected:false});
  return snapshot();
 }
 function start(value,opts={}){
  const username=normalizeUsername(value);
  if(!username)throw Object.assign(Error('Ingresá un @usuario válido de TikTok, sin enlaces ni espacios.'),{status:400});
  if(!opts.force&&data.username.toLowerCase()===username.toLowerCase()&&
    ['connecting','connected'].includes(data.status))return snapshot();
  stop();
  const current=++generation;
  data.username=username;data.status='connecting';data.updatedAt=fresh();
  const addComment=event=>{
   const entry=normalizeComment(event,++nextId,fresh());
   if(!entry)return;
   const source=event?.chatMessage||event?.data||event?.message||event;
   const rawId=source?.msgId||source?.messageId||source?.common?.msgId;
   const fingerprint=rawId?'id:'+rawId:
    'text:'+entry.username+':'+entry.text;
   const stamp=fresh(),previous=recentFingerprints.get(fingerprint)||0;
   if(previous&&stamp-previous<(rawId?60000:1200))return;
   recentFingerprints.set(fingerprint,stamp);
   if(recentFingerprints.size>180){
    for(const [key,at] of recentFingerprints)if(stamp-at>60000)recentFingerprints.delete(key);
    if(recentFingerprints.size>180)recentFingerprints.clear();
   }
   data.comments.push(entry);
   if(data.comments.length>MAX_COMMENTS)data.comments.splice(0,data.comments.length-MAX_COMMENTS);
   data.lastCommentAt=stamp;data.updatedAt=stamp;
  };
  (async()=>{
   let connection;
   try{
    const library=await load();
    if(current!==generation)return;
    const Connection=library.TikTokLiveConnection||library.default?.TikTokLiveConnection;
    if(typeof Connection!=='function')throw Error('No se pudo cargar el lector de TikTok.');
    connection=new Connection(username);
    active=connection;
    const chatEvent=library.WebcastEvent?.CHAT||'chat';
    connection.on(chatEvent,event=>{
     if(current!==generation)return;
     data.chatEvents++;data.lastEventAt=fresh();data.updatedAt=fresh();
     addComment(event);
    });
    connection.on('decodedData',(type,event)=>{
     if(current!==generation)return;
     data.decodedEvents++;data.lastEventAt=fresh();data.updatedAt=fresh();
     if(/^(WebcastChatMessage|chat)$/i.test(String(type||'')))addComment(event);
    });
    connection.on('websocketConnected',()=>{
     if(current!==generation)return;
     data.socketConnected=true;data.lastEventAt=fresh();data.updatedAt=fresh();
    });
    connection.on('websocketData',()=>{
     if(current!==generation)return;
     data.wsFrames++;data.lastEventAt=fresh();data.updatedAt=fresh();
    });
    connection.on('connected',state=>{
     if(current!==generation)return;
     data.status='connected';data.error='';data.connectedAt=fresh();
     data.roomId=String(state?.roomId||connection.roomId||'')||null;
     data.updatedAt=fresh();
    });
    connection.on('streamEnd',()=>{
     if(current!==generation)return;
     data.status='ended';data.error='El LIVE terminó.';data.updatedAt=fresh();
    });
    connection.on('disconnected',detail=>{
     if(current!==generation||['ended','error','idle'].includes(data.status))return;
     data.status='disconnected';
     data.error='Se perdió la conexión'+(detail?.reason?' ('+String(detail.reason).slice(0,60)+')':'')+'. Tocá Reconectar (↻).';
     data.updatedAt=fresh();
    });
    connection.on('error',error=>{
     if(current!==generation)return;
     data.error=String(error?.exception?.message||error?.info||error?.message||'Error de TikTok').slice(0,220);
     data.updatedAt=fresh();
    });
    const state=await connection.connect();
    if(current!==generation){try{await connection.disconnect()}catch{}return}
    if(!['disconnected','ended','error'].includes(data.status)){
     data.status='connected';data.connectedAt=data.connectedAt||fresh();
     data.roomId=String(state?.roomId||connection.roomId||'')||null;
     data.updatedAt=fresh();
    }
   }catch(error){
    if(current!==generation)return;
    data.status='error';
    data.error=String(error?.exception?.message||error?.message||'No se pudo conectar a TikTok LIVE.').slice(0,220);
    data.updatedAt=fresh();
    if(connection)try{await connection.disconnect()}catch{}
    if(current===generation)active=null;
   }
  })().catch(error=>{
   if(current===generation){data.status='error';data.error=String(error?.message||'Error de conexión').slice(0,220)}
  });
  return snapshot();
 }
 return {start,stop,snapshot};
}
module.exports={createTikTokChat,normalizeUsername,normalizeComment};
