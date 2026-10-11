'use strict';
// Puente TikTok LIVE (no oficial). Solo lectura. Los controles son privados.
const MAX_COMMENTS=75,MAX_EVENTS=75;
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
function normalizeGift(e,id,at=Date.now()){
 const x=e?.giftMessage||e?.data||e?.message||e;
 if(!x||typeof x!=='object')return null;
 const d=x.giftDetails||x.gift||{},u=x.user||{};
 const giftId=String(x.giftId??d.giftId??d.gift_id??'').slice(0,45);
 const giftName=String(d.giftName||x.giftName||x.extendedGiftInfo?.name||x.extendedGiftInfo?.giftName||d.name||(giftId?'Regalo #'+giftId:'Regalo')).trim().slice(0,70);
 const username=String(u.uniqueId||x.uniqueId||'espectador').slice(0,40);
 const name=String(u.nickname||x.nickname||username).slice(0,50);
 const n=Number(x.repeatCount??d.repeatCount??d.repeat_count??1);
 const count=Number.isFinite(n)?Math.max(1,Math.min(100000,Math.floor(n))):1;
 const streak=Number(d.giftType??d.gift_type??x.giftType)===1;
 const end=x.repeatEnd??d.repeatEnd??d.repeat_end;
 const pending=streak&&(end===undefined||end===false||end===0);
 const groupId=String(x.groupId||x.group_id||'').slice(0,90);
 const msgId=String(x.msgId||x.messageId||x.common?.msgId||'').slice(0,90);
 const emoji=/rose|rosa/i.test(giftName)?'🌹':/lion|le[oó]n/i.test(giftName)?'🦁':/heart|coraz[oó]n/i.test(giftName)?'❤️':'🎁';
 return {id,kind:'gift',username,name,giftName,giftId,count,emoji,streak,pending,groupId,msgId,at};
}
function createTikTokChat(options={}){
 const load=options.loadConnector||(()=>import('tiktok-live-connector'));
 const now=options.now||Date.now;
 let generation=0,active=null,nextId=0;
 let recentFingerprints=new Map(),giftFingerprints=new Map(),giftStreaks=new Map();
 const fresh=()=>now();
 const data={username:'',status:'idle',error:'',roomId:null,comments:[],events:[],giftEvents:0,
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
  return {...data,warning,comments:data.comments.slice(),events:data.events.map(e=>({...e}))};
 }
 function stop(){
  generation++;
  const old=active;active=null;
  if(old)try{Promise.resolve(old.disconnect()).catch(()=>{})}catch{}
  recentFingerprints.clear();giftFingerprints.clear();giftStreaks.clear();
  Object.assign(data,{username:'',status:'idle',error:'',roomId:null,comments:[],events:[],giftEvents:0,updatedAt:fresh(),
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
   data.events.push({...entry,kind:'comment'});
   if(data.events.length>MAX_EVENTS)data.events.splice(0,data.events.length-MAX_EVENTS);
   data.lastCommentAt=stamp;data.updatedAt=stamp;
  };
  const addGift=event=>{
   const gift=normalizeGift(event,++nextId,fresh());
   if(!gift)return;
   const stamp=fresh();
   const fingerprint=gift.msgId?'id:'+gift.msgId+':'+gift.count+':'+gift.pending:
    'gift:'+gift.username+':'+gift.giftId+':'+gift.count+':'+gift.pending;
   const last=giftFingerprints.get(fingerprint);
   if(last!==undefined&&stamp-last<(gift.msgId?60000:900))return;
   giftFingerprints.set(fingerprint,stamp);
   if(giftFingerprints.size>200){
    for(const [key,at] of giftFingerprints)if(stamp-at>60000)giftFingerprints.delete(key);
    if(giftFingerprints.size>200)giftFingerprints.clear();
   }
   const streakKey=gift.groupId?'group:'+gift.groupId:'user:'+gift.username+':'+gift.giftId;
   const old=gift.streak?giftStreaks.get(streakKey):null;
   const row=old&&stamp-old.at<90000?data.events.find(item=>item.id===old.id&&item.kind==='gift'):null;
   if(row&&(!old.finished||(Boolean(gift.groupId)&&!gift.pending))){
    row.count=Math.max(row.count,gift.count);
    row.pending=old.finished?false:gift.pending;
    row.at=stamp;
    giftStreaks.set(streakKey,{id:row.id,at:stamp,finished:!row.pending});
   }else{
    data.events.push(gift);
    if(data.events.length>MAX_EVENTS)data.events.splice(0,data.events.length-MAX_EVENTS);
    if(gift.streak)giftStreaks.set(streakKey,{id:gift.id,at:stamp,finished:!gift.pending});
   }
   data.giftEvents++;data.updatedAt=stamp;
  };
  (async()=>{
   let connection;
   try{
    const library=await load();
    if(current!==generation)return;
    const Connection=library.TikTokLiveConnection||library.default?.TikTokLiveConnection;
    if(typeof Connection!=='function')throw Error('No se pudo cargar el lector de TikTok.');
    connection=new Connection(username,{processInitialData:true});
    active=connection;
    const chatEvent=library.WebcastEvent?.CHAT||'chat';
    const giftEvent=library.WebcastEvent?.GIFT||'gift';
    connection.on(chatEvent,event=>{
     if(current!==generation)return;
     data.chatEvents++;data.lastEventAt=fresh();data.updatedAt=fresh();
     addComment(event);
    });
    connection.on(giftEvent,event=>{
     if(current!==generation||!event)return;
     data.lastEventAt=fresh();data.updatedAt=fresh();addGift(event);
    });
    connection.on('decodedData',(type,event)=>{
     if(current!==generation)return;
     data.decodedEvents++;data.lastEventAt=fresh();data.updatedAt=fresh();
     if(/^(WebcastChatMessage|chat)$/i.test(String(type||'')))addComment(event);
     if(/^(WebcastGiftMessage|gift)$/i.test(String(type||'')))addGift(event);
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
module.exports={createTikTokChat,normalizeUsername,normalizeComment,normalizeGift};
