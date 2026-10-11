'use strict';
// Puente de lectura TikTok LIVE -> panel privado. No envía comentarios ni credenciales.
const MAX_COMMENTS=75;
function normalizeUsername(value){
 const input=String(value||'').trim().replace(/^@/,'');
 return /^[a-zA-Z0-9._]{2,30}$/.test(input)?input:null;
}
function normalizeComment(event,id,now=Date.now()){
 const text=String(event?.comment||'').trim().slice(0,420);
 if(!text)return null;
 const user=event?.user||{};
 const uniqueId=String(user.uniqueId||event?.uniqueId||'espectador').slice(0,40);
 const nickname=String(user.nickname||user.nickName||event?.nickname||uniqueId).slice(0,50);
 return {id,username:uniqueId,name:nickname,text,at:now};
}
function createTikTokChat(options={}){
 const load=options.loadConnector||(()=>import('tiktok-live-connector'));
 let generation=0,active=null,nextId=0;
 const data={username:'',status:'idle',error:'',roomId:null,comments:[],updatedAt:Date.now()};
 function snapshot(){return {...data,comments:data.comments.slice()}}
 function stop(){
  generation++;
  const old=active;active=null;
  if(old)try{Promise.resolve(old.disconnect()).catch(()=>{})}catch{}
  data.status='idle';data.error='';data.roomId=null;data.comments=[];data.updatedAt=Date.now();
  return snapshot();
 }
 function start(value){
  const username=normalizeUsername(value);
  if(!username)throw Object.assign(Error('Ingresá un usuario de TikTok válido (sin enlaces ni espacios).'),{status:400});
  if(data.username===username&&['connecting','connected'].includes(data.status))return snapshot();
  stop();
  const current=++generation;
  data.username=username;data.status='connecting';data.updatedAt=Date.now();
  (async()=>{
   let connection;
   try{
    const library=await load();
    if(current!==generation)return;
    const Connection=library.TikTokLiveConnection||library.default?.TikTokLiveConnection;
    if(typeof Connection!=='function')throw Error('El conector de TikTok no está disponible.');
    const chatEvent=library.WebcastEvent?.CHAT||'chat';
    connection=new Connection(username,{processInitialData:true});
    active=connection;
    connection.on(chatEvent,event=>{
     if(current!==generation||!event)return;
     const entry=normalizeComment(event,++nextId);
     if(!entry)return;
     data.comments.push(entry);
     if(data.comments.length>MAX_COMMENTS)data.comments.splice(0,data.comments.length-MAX_COMMENTS);
     data.updatedAt=Date.now();
    });
    connection.on('connected',state=>{
     if(current!==generation)return;
     data.status='connected';data.error='';data.roomId=String(state?.roomId||connection.roomId||'')||null;data.updatedAt=Date.now();
    });
    connection.on('streamEnd',()=>{
     if(current!==generation)return;
     data.status='ended';data.error='El LIVE terminó.';data.updatedAt=Date.now();
    });
    connection.on('disconnected',()=>{
     if(current!==generation||['ended','error','idle'].includes(data.status))return;
     data.status='disconnected';data.error='Se perdió la conexión. Tocá Reconectar.';data.updatedAt=Date.now();
    });
    connection.on('error',error=>{
     if(current!==generation)return;
     data.error=String(error?.message||'Error temporal de TikTok').slice(0,220);
     data.updatedAt=Date.now();
    });
    const state=await connection.connect();
    if(current!==generation){
     try{await connection.disconnect()}catch{}
     return;
    }
    data.status='connected';data.error='';data.roomId=String(state?.roomId||connection.roomId||'')||null;data.updatedAt=Date.now();
   }catch(error){
    if(current!==generation)return;
    data.status='error';
    data.error=String(error?.message||'No se pudo conectar a TikTok LIVE.').slice(0,220);
    data.updatedAt=Date.now();
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
