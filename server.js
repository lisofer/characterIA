import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import sharp from 'sharp';
import {rateLimit} from 'express-rate-limit';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import {WebSocketServer} from 'ws';
import {fileURLToPath} from 'node:url';
import {DATA_DIR,db,allSettings,setSettings,createProfile,getProfile,eraseProfile,createSession,resolveSession,removeSession,replaceSessionProfile,listDocs,lookupDoc} from './db.js';
import {makeLive,voiceSample,wav,VOICE_NAMES} from './live.js';
import {makeCarmenLive,getCarmenSettings,saveCarmenSettings} from './carmen-live.js';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false,crossOriginEmbedderPolicy:false}));
app.use(express.json({limit:'64kb'}));
const parseCookie=req=>(req.headers.cookie||'').split(';').map(p=>p.trim()).find(p=>p.startsWith('cv_session='))?.slice(11)||'';
function session(req){return resolveSession(parseCookie(req))}
function auth(role){return(req,res,next)=>{const s=session(req);if(!s||role&&s.role!==role)return res.status(401).json({error:'Necesitás iniciar sesión.'});req.session=s;req.profileId=s.profile_id;next();}}
const secureCookie=()=>process.env.NODE_ENV==='production'?'; Secure':'';
const cookie=(res,value,maxAge=180*86400)=>res.setHeader('Set-Cookie',`cv_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie()}`);
function checkPassword(expected,actual){if(!expected)return false;const a=Buffer.from(crypto.createHash('sha256').update(String(actual||'')).digest('hex'),'hex');const b=Buffer.from(crypto.createHash('sha256').update(expected).digest('hex'),'hex');return crypto.timingSafeEqual(a,b);}
app.get('/health',(req,res)=>res.json({ok:true,storage:fs.existsSync(DATA_DIR)}));
const loginLimiter=rateLimit({windowMs:15*60000,limit:12,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Demasiados intentos. Volvé a probar más tarde.'}});
app.post('/api/login',loginLimiter,(req,res)=>{const pwd=req.body?.password;let role=null;if(checkPassword(process.env.ADMIN_PASSWORD,pwd))role='admin';else if(checkPassword(process.env.STUDENT_PASSWORD,pwd))role='student';if(!role)return res.status(401).json({error:'Contraseña incorrecta.'});
 const old=session(req);let profileId=role==='student'?(old?.role==='student'&&getProfile(old.profile_id)?old.profile_id:createProfile()):null;
 if(old)removeSession(parseCookie(req));const token=createSession(role,profileId);cookie(res,token);res.json({role,profileId});});
// Ticket de acceso efímero para contraseñas dictadas al avatar Carmen.
const carmenTickets=new Map();
const carmenAttempts=new Map();
function verifyCarmenPassword(password,ip){
 const now=Date.now(),entry=carmenAttempts.get(ip)||{count:0,until:now+15*60_000};
 if(now>entry.until){entry.count=0;entry.until=now+15*60_000;}
 if(entry.count>=12)return {locked:true};
 entry.count++;carmenAttempts.set(ip,entry);
 const role=checkPassword(process.env.ADMIN_PASSWORD,password)?'admin':
            checkPassword(process.env.STUDENT_PASSWORD,password)?'student':null;
 if(!role)return {locked:entry.count>=12};
 entry.count=0;
 const ticket=crypto.randomBytes(32).toString('base64url');
 carmenTickets.set(crypto.createHash('sha256').update(ticket).digest('hex'),{role,expires:now+30000});
 return {ticket};
}
const redeemLimiter=rateLimit({windowMs:15*60_000,limit:18,standardHeaders:'draft-7',legacyHeaders:false});
app.post('/api/carmen/redeem',redeemLimiter,(req,res)=>{
 const ticket=String(req.body?.ticket||'');
 if(!/^[a-zA-Z0-9_-]{40,60}$/.test(ticket))return res.status(401).json({error:'Autorización vencida. Volvé a intentar.'});
 const hash=crypto.createHash('sha256').update(ticket).digest('hex');
 const grant=carmenTickets.get(hash);carmenTickets.delete(hash);
 if(!grant||grant.expires<Date.now())return res.status(401).json({error:'Autorización vencida. Volvé a intentar.'});
 const old=session(req);
 const profileId=grant.role==='student'?(old?.role==='student'&&getProfile(old.profile_id)?old.profile_id:createProfile()):null;
 if(old)removeSession(parseCookie(req));
 cookie(res,createSession(grant.role,profileId));
 res.json({role:grant.role,profileId});
});
app.get('/api/carmen/config',(req,res)=>{
 const {prompt,...config}=getCarmenSettings();
 res.json({config,frames:Array.from({length:8},(_,i)=>fs.existsSync(path.join(DATA_DIR,'carmen-frames',i+'.png')))});
});
const carmenFrameDir=path.join(DATA_DIR,'carmen-frames');
fs.mkdirSync(carmenFrameDir,{recursive:true});
app.get('/api/carmen/frames/:index',async(req,res)=>{
 const i=Number(req.params.index);
 if(!Number.isInteger(i)||i<0||i>7)return res.sendStatus(404);
 const filename=path.join(carmenFrameDir,i+'.png');
 if(!fs.existsSync(filename))return res.sendStatus(404);
 res.set('Cache-Control','private, no-cache');
 try{res.type('webp').send(await optimizedFrame(i+8,filename));}
 catch{res.type('png').sendFile(path.resolve(filename));}
});
app.get('/api/admin/carmen/config',auth('admin'),(req,res)=>res.json({
 config:getCarmenSettings(),frames:Array.from({length:8},(_,i)=>fs.existsSync(path.join(carmenFrameDir,i+'.png'))),
 voices:VOICE_NAMES,geminiReady:!!process.env.GEMINI_API_KEY
}));
app.put('/api/admin/carmen/config',auth('admin'),(req,res)=>{
 try{res.json({ok:true,config:saveCarmenSettings(req.body?.config||{})});}
 catch(error){res.status(400).json({error:String(error.message||error)});}
});
app.post('/api/logout',auth(),(req,res)=>{removeSession(parseCookie(req));cookie(res,'',0);res.json({ok:true});});
app.get('/api/me',(req,res)=>{const s=session(req);if(!s)return res.json({role:null});res.json({role:s.role,profile:s.role==='student'?getProfile(s.profile_id)?.fields||{}:null,documents:s.role==='student'?listDocs(s.profile_id):[],config:s.role==='student'?publicSettings():allSettings()});});
function publicSettings(){const s=allSettings();return Object.fromEntries(['subtitleFont','subtitleWidth','subtitleDelay','mouthDelay','mouthSensitivity','mouthSmoothing','blinkRate','mouthAmplitude','avatarScale','avatarOffsetX','avatarOffsetY','avatarFit'].map(k=>[k,s[k]]));}
// Los PNG originales permanecen en /data. Para Android, se envían variantes
// WebP reducidas: evita decodificar ocho texturas de hasta 4096 x 4096 en Chrome.
const optimizedFrameCache=new Map();
async function optimizedFrame(i,file){
 const stat=await fs.promises.stat(file);
 const version=`${stat.mtimeMs}:${stat.size}`;
 const cached=optimizedFrameCache.get(i);
 if(cached?.version===version)return cached.promise;
 const promise=sharp(file,{limitInputPixels:20000000})
  .resize({width:1024,height:1536,fit:'inside',withoutEnlargement:true})
  .webp({quality:82,effort:4}).toBuffer();
 optimizedFrameCache.set(i,{version,promise});
 promise.catch(()=>{if(optimizedFrameCache.get(i)?.promise===promise)optimizedFrameCache.delete(i);});
 return promise;
}
app.get('/api/frames/:index',auth(),async(req,res)=>{
 const i=Number(req.params.index);
 if(!Number.isInteger(i)||i<0||i>7)return res.sendStatus(404);
 const file=path.join(DATA_DIR,'frames',`${i}.png`);
 if(!fs.existsSync(file))return res.sendStatus(404);
 res.set('Cache-Control','private, no-cache');
 if(req.query.optimized==='1'){
  try{
   const webp=await optimizedFrame(i,file);
   if(res.headersSent)return;
   res.type('webp').send(webp);
  }catch(err){
   console.warn('No se pudo optimizar fotograma',i,err.message);
   if(!res.headersSent)res.type('png').sendFile(path.resolve(file));
  }
  return;
 }
 res.type('png').sendFile(path.resolve(file));
});
app.post('/api/reset',auth('student'),(req,res)=>{if(req.body?.confirm!==true)return res.status(400).json({error:'Confirmá el reinicio para borrar todo el CV.'});const old=req.profileId;for(const f of eraseProfile(old))try{fs.unlinkSync(path.join(DATA_DIR,'cvs',f))}catch{}const fresh=createProfile();replaceSessionProfile(parseCookie(req),fresh);res.json({ok:true,profile:{},documents:[]});});
function safeCvDownloadName(profile){
 const f=profile?.fields||{};
 const full=[f.nombre,f.apellido].filter(Boolean).join(' ').normalize('NFC')
  .replace(/[\\/:*?"<>|\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim().slice(0,100);
 return (full||'Curriculum')+' CV.pdf';
}
app.get('/api/cv/:doc',auth('student'),(req,res)=>{const d=lookupDoc(req.params.doc,req.profileId);if(!d)return res.sendStatus(404);const file=path.join(DATA_DIR,'cvs',d.filename);if(!fs.existsSync(file))return res.sendStatus(404);res.download(file,safeCvDownloadName(getProfile(req.profileId)));});
app.get('/api/admin/config',auth('admin'),(req,res)=>res.json({config:allSettings(),frames:Array.from({length:8},(_,i)=>fs.existsSync(path.join(DATA_DIR,'frames',`${i}.png`))),voices:VOICE_NAMES,geminiReady:!!process.env.GEMINI_API_KEY}));
app.put('/api/admin/config',auth('admin'),(req,res)=>{const old=allSettings();const next={};for(const [k,v]of Object.entries(req.body?.config||{})){if(!Object.hasOwn(old,k))continue;if(typeof old[k]==='number'){const n=Number(v);if(!Number.isFinite(n))continue;next[k]=k==='subtitleDelay'?Math.max(-1200,Math.min(1200,n)):Math.max(-500,Math.min(2000,n));}else if(typeof old[k]==='string'){if(!['prompt','personality'].includes(k)&&String(v).length>200)continue;if(k==='prompt'&&String(v).length>32000)return res.status(400).json({error:'El prompt supera el máximo de 32.000 caracteres; no se guardó incompleto.'});next[k]=String(v).slice(0,k==='prompt'?32000:4000);}}

 if(next.voice&&!VOICE_NAMES.includes(next.voice))return res.status(400).json({error:'Voz no reconocida'});
 if(next.model&&!['gemini-3.8-live','gemini-3.1-flash-live-preview'].includes(next.model))return res.status(400).json({error:'Modelo no permitido'});
 if(next.fallback&&!['gemini-3.8-live','gemini-3.1-flash-live-preview'].includes(next.fallback))return res.status(400).json({error:'Modelo de respaldo no permitido'});
 setSettings(next);res.json({ok:true,config:allSettings()});});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1}});
app.post('/api/admin/frames/:index',auth('admin'),upload.single('image'),(req,res)=>{const i=Number(req.params.index);if(!Number.isInteger(i)||i<0||i>7)return res.sendStatus(404);const b=req.file?.buffer;if(!b||b.length<24||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return res.status(400).json({error:'Seleccioná un archivo PNG válido.'});const width=b.readUInt32BE(16),height=b.readUInt32BE(20);if(width>4096||height>4096||width<100||height<100)return res.status(400).json({error:'Dimensiones no válidas'});fs.writeFileSync(path.join(DATA_DIR,'frames',`${i}.png`),b);res.json({ok:true,width,height});});
app.post('/api/admin/carmen/frames/:index',auth('admin'),upload.single('image'),(req,res)=>{
 const i=Number(req.params.index),b=req.file?.buffer;
 if(!Number.isInteger(i)||i<0||i>7)return res.sendStatus(404);
 if(!b||b.length<24||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return res.status(400).json({error:'Seleccioná un PNG válido.'});
 const width=b.readUInt32BE(16),height=b.readUInt32BE(20);
 if(width<100||height<100||width>4096||height>4096)return res.status(400).json({error:'Tamaño de PNG no permitido.'});
 fs.writeFileSync(path.join(carmenFrameDir,i+'.png'),b);
 res.json({ok:true,width,height});
});
app.post('/api/admin/carmen/voice-sample',auth('admin'),rateLimit({windowMs:60000,limit:6}),async(req,res)=>{
 try{const voice=String(req.body?.voice||getCarmenSettings().voice);
  if(!VOICE_NAMES.includes(voice))return res.status(400).json({error:'Voz inválida.'});
  const output=await voiceSample(voice);
  res.type('audio/wav').send(wav(output.bytes));
 }catch(error){res.status(502).json({error:String(error.message||error)});}
});
app.post('/api/admin/voice-sample',auth('admin'),rateLimit({windowMs:60000,limit:6}),async(req,res)=>{try{const v=req.body?.voice||allSettings().voice;if(!VOICE_NAMES.includes(v))return res.status(400).json({error:'Voz inválida'});const sample=await voiceSample(v);res.type('audio/wav');res.set('X-Gemini-Model',sample.model);res.send(wav(sample.bytes));}catch(e){res.status(502).json({error:String(e.message||e)});}});

app.use(express.static(path.join(ROOT,'public'),{index:'index.html',maxAge:0}));
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));
app.use((err,req,res,next)=>res.status(err.code==='LIMIT_FILE_SIZE'?413:400).json({error:err.message||'Error'}));
const server=http.createServer(app);const wss=new WebSocketServer({noServer:true,maxPayload:150000});
const carmenWss=new WebSocketServer({noServer:true,maxPayload:150000});
const activeCarmen=new Map();
server.on('upgrade',(req,socket,head)=>{
 const origin=req.headers.origin,host=req.headers.host;
 if(origin){try{if(new URL(origin).host!==host){socket.destroy();return;}}catch{socket.destroy();return;}}
 const pathname=new URL(req.url,'http://localhost').pathname;
 const sess=session(req);
 if(pathname==='/api/carmen/live'){
  if(sess){socket.destroy();return;}
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
  const count=activeCarmen.get(ip)||0;
  if(count>=3){socket.destroy();return;}
  activeCarmen.set(ip,count+1);
  carmenWss.handleUpgrade(req,socket,head,ws=>carmenWss.emit('connection',ws,req,ip));return;
 }
 if(!sess||sess.role!=='student'||pathname!=='/api/live'){socket.destroy();return;}
 wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req,sess));
});
wss.on('connection',async(ws,req,s)=>{const live=makeLive(ws,s.profile_id);let connected=false;try{await live.connect();connected=true;}catch(e){ws.send(JSON.stringify({type:'error',message:String(e.message||e)}));ws.close();return;}
 ws.on('message',data=>{try{const m=JSON.parse(String(data));if(m.type==='start')live.initial();else if(m.type==='text')live.sendText(m.text);else if(m.type==='audio')live.sendAudio(m.pcm);else if(m.type==='audio_end')live.stopAudio();}catch(e){if(ws.readyState===1)ws.send(JSON.stringify({type:'error',message:String(e.message||e)}));}});
 ws.on('close',()=>live.close());});
carmenWss.on('connection',async(ws,req,ip)=>{
 const live=makeCarmenLive(ws,{verifyPassword:password=>verifyCarmenPassword(password,ip)});
 const lifetime=setTimeout(()=>ws.close(1000,'Fin de sesión'),5*60*1000);
 ws.on('close',()=>{
  clearTimeout(lifetime);
  activeCarmen.set(ip,Math.max(0,(activeCarmen.get(ip)||1)-1));
  live.close();
 });
 ws.on('message',data=>{
  try{
   const msg=JSON.parse(String(data));
   if(msg.type==='start')live.initial();
   else if(msg.type==='audio')live.sendAudio(msg.pcm);
   else if(msg.type==='text')live.sendText(msg.text);
  }catch{if(ws.readyState===1)ws.send(JSON.stringify({type:'error',message:'No se pudo procesar el mensaje.'}));}
 });
 try{
  if(!process.env.GEMINI_API_KEY)throw Error('Gemini Live no está disponible.');
  await live.connect();
 }catch(error){
  if(ws.readyState===1){ws.send(JSON.stringify({type:'error',message:'No se pudo conectar con la voz de Carmen.'}));ws.close();}
 }
});
const port=Number(process.env.PORT||3000);server.listen(port,'0.0.0.0',()=>console.log(`CV Accesible escuchando puerto ${port}`));
