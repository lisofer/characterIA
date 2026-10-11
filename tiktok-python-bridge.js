'use strict';
// Python vive en el mismo contenedor de Persona Studio; stdout usa NDJSON privado.
// Ningún puerto adicional ni credencial TikTok se expone al navegador.
const {spawn}=require('node:child_process');
const path=require('node:path');
const USERNAME=/^[a-zA-Z0-9._]{2,30}$/;
function createPythonGiftBridge(opts={}){
 const launch=opts.spawn||spawn;
 const interpreter=opts.python||process.env.TIKTOK_PYTHON||'python3';
 const script=opts.script||path.join(__dirname,'tiktok-python-worker.py');
 const onGift=opts.onGift||(()=>{});
 const onState=opts.onState||(()=>{});
 let processRef=null,token=0;
 const state={username:'',status:'idle',error:'',roomId:'',gifts:0,lastGiftAt:0,updatedAt:Date.now()};
 const snapshot=()=>({...state});
 function transition(patch){Object.assign(state,patch,{updatedAt:Date.now()});try{onState(snapshot())}catch{}}
 function stop(){
  token++;
  const old=processRef;processRef=null;
  if(old)try{old.kill('SIGTERM')}catch{}
  transition({username:'',status:'idle',error:'',roomId:'',gifts:0,lastGiftAt:0});
 }
 function start(name){
  const username=String(name||'').replace(/^@/,'').trim();
  if(!USERNAME.test(username)){stop();transition({status:'error',error:'@usuario inválido'});return snapshot()}
  stop();const mine=++token;
  transition({username,status:'starting',error:'',roomId:'',gifts:0,lastGiftAt:0});
  let worker;
  try{
   worker=launch(interpreter,['-u',script,'@'+username],{cwd:__dirname,
    stdio:['ignore','pipe','pipe'],env:process.env});
  }catch(e){
   if(mine===token)transition({status:'error',error:'No se pudo iniciar Python: '+String(e.message||e).slice(0,180)});
   return snapshot();
  }
  processRef=worker;
  let partial='',stderr='';
  const read=data=>{
   if(mine!==token)return;
   partial+=String(data);
   if(partial.length>131072){partial='';transition({status:'error',error:'Se excedió el tamaño de respuesta del lector Python.'});return}
   let pos;
   while((pos=partial.indexOf('\n'))>=0){
    const line=partial.slice(0,pos).trim();partial=partial.slice(pos+1);
    if(!line||line.length>8192)continue;
    let msg;try{msg=JSON.parse(line)}catch{continue}
    if(msg.type==='connected'){
     transition({status:'connected',error:'',roomId:String(msg.roomId||'').slice(0,80)});
    }else if(msg.type==='gift'&&msg.user&&typeof msg.user==='object'){
     if(state.status==='error'||state.status==='idle')continue;
     const text=String(msg.giftName||'Regalo').slice(0,90);
     const count=Math.max(1,Math.min(100000,Math.floor(Number(msg.count)||1)));
     const event={giftId:String(msg.giftId||'').slice(0,45),giftName:text,repeatCount:count,
       repeatEnd:true,user:{displayId:String(msg.user.username||'').slice(0,40),
        nickname:String(msg.user.name||msg.user.username||'').slice(0,50)},
       msgId:String(msg.messageId||'').slice(0,100)};
     transition({gifts:state.gifts+1,lastGiftAt:Date.now()});
     try{onGift(event)}catch(e){console.warn('TikTok Python gift bridge:',e?.message)}
    }else if(msg.type==='error'){
     transition({status:'error',error:String(msg.message||'Error de TikTokLive Python').slice(0,230)});
    }else if(msg.type==='disconnected'&&state.status!=='error'){
     transition({status:'disconnected',error:'La conexión Python terminó.'});
    }
   }
  };
  worker.stdout?.on('data',read);
  worker.stderr?.on('data',data=>{if(mine===token)stderr=(stderr+String(data)).slice(-650)});
  worker.on('error',e=>{
   if(mine!==token)return;
   transition({status:'error',error:'No se pudo iniciar el lector Python: '+String(e.message||e).slice(0,180)});
  });
  worker.on('exit',(code,signal)=>{
   if(mine!==token)return;
   processRef=null;
   if(state.status==='error'||state.status==='disconnected')return;
   const hint=stderr.trim().split('\n').at(-1)?.slice(0,140)||'';
   transition({status:'error',error:hint||'El lector Python se cerró ('+(signal||code)+').'});
  });
  return snapshot();
 }
 return {start,stop,snapshot};
}
module.exports={createPythonGiftBridge};
