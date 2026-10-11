'use strict';
// Puente TikTok LIVE (no oficial). Solo lectura. Los controles son privados.
const MAX_COMMENTS=75,MAX_EVENTS=75;
function normalizeUsername(value){
 const input=String(value||'').trim().replace(/^@/,'');
 return /^[a-zA-Z0-9._]{2,30}$/.test(input)?input:null;
}
// v2.5 emite protobufs crudos ({user:{displayId,...}}). Las versiones
// anteriores emitían atributos aplanados ({uniqueId,...}). decodedData puede
// envolverlos como {type:'WebcastChatMessage',data:{...}}.
function eventPayload(raw){
 let value=raw;
 for(let i=0;i<4&&value&&typeof value==='object';i++){
  if(value.chatMessage&&typeof value.chatMessage==='object'){value=value.chatMessage;continue}
  if(value.giftMessage&&typeof value.giftMessage==='object'){value=value.giftMessage;continue}
  if(value.data&&typeof value.data==='object'&&!Array.isArray(value.data)&&
     (value.type||!value.user&&!value.comment&&!value.giftId)){value=value.data;continue}
  if(value.message&&typeof value.message==='object'&&!Array.isArray(value.message)){
   value=value.message;continue
  }
  break;
 }
 return value&&typeof value==='object'?value:{};
}
function actorOf(source){
 const u=source.user&&typeof source.user==='object'?source.user:{};
 const asString=v=>typeof v==='string'?v.trim():'';
 const username=asString(u.uniqueId)||asString(u.displayId)||asString(u.username)||
  asString(u.handle)||asString(source.uniqueId)||asString(source.displayId)||
  asString(source.username)||asString(source.handle);
 const name=asString(u.nickname)||asString(u.nickName)||asString(source.nickname)||
  asString(source.nickName)||username||'Espectador';
 return {username:(username||name).slice(0,40),name:name.slice(0,50)};
}
function normalizeComment(event,id,now=Date.now()){
 const source=eventPayload(event);
 const text=String(source.comment??source.content??source.text??'').trim().slice(0,420);
 if(!text)return null;
 return {id,...actorOf(source),text,at:now};
}
function normalizeGift(event,id,at=Date.now()){
 const x=eventPayload(event);
 if(!x||typeof x!=='object')return null;
 const d=x.giftDetails&&typeof x.giftDetails==='object'?x.giftDetails:
  x.gift&&typeof x.gift==='object'?x.gift:{};
 const info=x.extendedGiftInfo&&typeof x.extendedGiftInfo==='object'?x.extendedGiftInfo:{};
 const giftId=String(x.giftId??d.giftId??d.gift_id??'').slice(0,45);
 const rawGiftName=d.giftName||x.giftName||info.name||info.giftName||d.name||
  (typeof x.describe==='string'?x.describe.replace(/^(?:sent|envió|enviado|envi[oó])\s+/i,''):'');
 // Identificación local de Rosa para no consultar un catálogo con tarifa Business.
 const giftName=String(rawGiftName||(giftId==='5655'?'Rosa':giftId?'Regalo #'+giftId:'Regalo')).trim().slice(0,70);
 const amount=Number(x.repeatCount??d.repeatCount??d.repeat_count??1);
 const count=Number.isFinite(amount)?Math.max(1,Math.min(100000,Math.floor(amount))):1;
 const streak=Number(d.giftType??d.gift_type??x.giftType)===1;
 const repeatEnd=x.repeatEnd??d.repeatEnd??d.repeat_end;
 const pending=streak&&(repeatEnd===undefined||repeatEnd===false||repeatEnd===0);
 const groupId=String(x.groupId||x.group_id||'').slice(0,90);
 const msgId=String(x.msgId||x.messageId||x.common?.msgId||'').slice(0,90);
 const emoji=/rose|rosa/i.test(giftName)?'🌹':/lion|le[oó]n/i.test(giftName)?'🦁':
  /heart|coraz[oó]n/i.test(giftName)?'❤️':'🎁';
 return {id,kind:'gift',...actorOf(x),giftName,giftId,count,emoji,streak,pending,groupId,msgId,at};
}
function decodedMessage(type,event){
 // decodedData en v2.5: (tipo, {type, data}, bytes).
 // Otros conectores pueden enviar un único objeto {type, data}.
 const envelope=typeof type==='string'?event:type;
 const name=typeof type==='string'?type:envelope?.type;
 return {type:String(name||''),data:eventPayload(envelope)};
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
   const source=eventPayload(event);
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
   if(last!==undefined&&stamp-last<(gift.msgId?60000:250))return;
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
    // La consulta opcional de regalos pide una firma de Euler de plan Business.
    // No la usamos: recibimos WebcastGiftMessage con la conexión común.
    connection=new Connection(username,{processInitialData:true,enableExtendedGiftInfo:false});
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
     const decoded=decodedMessage(type,event);
     if(/^(WebcastChatMessage|chat)$/i.test(decoded.type))addComment(decoded.data);
     if(/^(WebcastGiftMessage|gift)$/i.test(decoded.type))addGift(decoded.data);
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
module.exports={createTikTokChat,normalizeUsername,normalizeComment,normalizeGift,eventPayload,decodedMessage};
