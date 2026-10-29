import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import multer from 'multer';
import {GoogleGenAI,Modality} from '@google/genai';
import {DATA_DIR,allSettings} from './db.js';

const optimizedCache=new Map();
async function optimizedGuardFrame(index,file){
 const stat=await fs.promises.stat(file),version=stat.mtimeMs+':'+stat.size;
 const cached=optimizedCache.get(index);
 if(cached?.version===version)return cached.promise;
 const promise=sharp(file,{limitInputPixels:20000000})
  .resize({width:768,height:1024,fit:'inside',withoutEnlargement:true})
  .webp({quality:82,effort:3}).toBuffer();
 optimizedCache.set(index,{version,promise});
 promise.catch(()=>{if(optimizedCache.get(index)?.promise===promise)optimizedCache.delete(index);});
 return promise;
}

const frameDescriptions=['abiertos','cerrados','A','A y parpadeo','O','O y parpadeo','E','E y parpadeo'];
const framePath=path.join(DATA_DIR,'guard-frames');
fs.mkdirSync(framePath,{recursive:true});
const frameDir=framePath;
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1}});
const ERIK_MODEL='gemini-3.8-live';
const GUARD_WELCOME='Hola, soy Erik, el guardia de NEXOCV. Podés hablar conmigo o decir una contraseña de una sola palabra. También podés escribirla. Te escucho.';
export const ERIK_VOICES=['Charon','Puck','Fenrir','Orus','Enceladus','Iapetus','Algenib','Alnilam','Gacrux','Achird','Zubenelgenubi','Zephyr','Kore','Aoede'];
const availableVoice=name=>ERIK_VOICES.includes(name)?name:'Charon';
const send=(ws,type,data={})=>{if(ws.readyState===1)ws.send(JSON.stringify({type,...data}));};
export function makeGuardLive(ws){
 const conf=allSettings();
 const voice=availableVoice(conf.guardVoice);
 let live=null,closed=false,ready=false,turnOpen=false,lastInputTime=0,inputCount=0;
 let welcomeIssued=false;
 const stop=()=>{closed=true;try{live?.close()}catch{}};
 const noSecrets=text=>{
  const t=String(text||'').trim().replace(/\s+/g,' ');
  if(!t||t.length>300)return null;
  if(/^[\p{L}\p{N}_-]+[.!?]?$/u.test(t))return null;
  if(/\b(contrase(?:ñ|n)a|clave|password|pin|c[oó]digo\s+de\s+acceso)\b/iu.test(t))return null;
  return t;
 };
 const intentText={
  retry:'El servidor rechazó el último intento de acceso, sin compartirte el valor. Respondé con humor original y ofrecé otro intento.',
  help:'Explicá brevemente que una contraseña de una sola palabra puede decirse en voz alta o escribirse en el campo.',
  clarify:'La persona aludió a la clave sin dictar una sola palabra inequívoca. Pedí aclaración sin tratar de adivinar.',
  ask:'La persona reanudó la conversación. Retomá en una oración natural.',
  listening:'Informá brevemente que estás escuchando y puede hablar.'
 };
 const config={
  responseModalities:[Modality.AUDIO],
  outputAudioTranscription:{},
  speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:voice}}},
  systemInstruction:{parts:[{text:[
   'SOS ERIK, EL GUARDIA DE NEXOCV. Este personaje es independiente de NEXO, la orientadora del CV.',
   String(conf.guardPrompt||''),
   'Respondé siempre en español argentino natural. Breve, espontáneo, algo caprichoso y gracioso, sin infantilizar ni discriminar.',
   'Si alguien te hace una broma, contestá a lo que dijo: podés charlar sin pedir la contraseña cada vez.',
   'Nunca recibís la clave: el navegador decide cuándo una palabra es contraseña y la verifica directamente en el servidor.',
   'Nunca reveles, inventes, adivines o pidas que repitan la contraseña como parte de una charla.',
   'En el saludo inicial, decí claramente que sos Erik, que hay un portero de voz y que se puede ingresar hablando o escribiendo.',
   'Una sola intervención por turno, sin etiquetas, sin nombrar modelos ni herramientas.'
  ].join('\n\n')}]}
 };
 const connect=async()=>{
  if(!process.env.GEMINI_API_KEY)throw new Error('GEMINI_API_KEY no está configurada');
  const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
  live=await ai.live.connect({model:ERIK_MODEL,config,callbacks:{
   onopen:()=>{},
   onmessage:m=>{
    if(closed)return;
    const sc=m.serverContent||{};
    if(sc.interrupted)send(ws,'interrupted');
    for(const part of sc.modelTurn?.parts||[])
     if(part.inlineData?.data)send(ws,'audio',{pcm:part.inlineData.data,mimeType:part.inlineData.mimeType||'audio/pcm;rate=24000'});
    if(sc.outputTranscription?.text)send(ws,'transcript',{text:sc.outputTranscription.text});
    if(sc.turnComplete){turnOpen=false;send(ws,'turn_complete');}
   },
   onerror:e=>{if(!closed){console.warn('Erik Live error:',String(e?.message||e).slice(0,150));send(ws,'error',{message:'Gemini 3.8 Live no está disponible.'});try{ws.close()}catch{}}},
   onclose:e=>{if(!closed){send(ws,'closed',{message:'Se cerró Gemini 3.8 Live. Tocá a Erik para reconectar.'});try{ws.close()}catch{}}}
  }});
  if(closed){try{live.close()}catch{};return;}
  ready=true;send(ws,'connected',{model:ERIK_MODEL,voice});
  // Saluda primero, aunque el usuario no pueda ver el personaje ni haya activado el micrófono.
  if(!welcomeIssued){
   welcomeIssued=true;turnOpen=true;
   live.sendClientContent({turns:[{role:'user',parts:[{text:'[INICIO DE VISITA] Presentate ahora como Erik en voz alta. Explicá brevemente el acceso por voz o teclado y que estás escuchando.'}]}],turnComplete:true});
  }
 };
 const handle=(raw)=>{
  if(!ready||closed)return;
  let m;try{m=JSON.parse(String(raw));}catch{return;}
  if(typeof m!=='object'||!m)return;
  if(!['text','intent','repeat','interrupt'].includes(m.type))return;
  // La cancelación se envía en la sesión Live de Erik, sin texto ni contraseña.
  // clientContent interrumpe la generación actual; el siguiente mensaje real
  // continúa la conversación con el mismo contexto.
  if(m.type==='interrupt'){
   try{live.sendClientContent({turnComplete:false});}
   catch{send(ws,'notice',{message:'Te escucho.'});}
   return;
  }
  const now=Date.now();
  if(now-lastInputTime<600)return;
  if(++inputCount>45){send(ws,'error',{message:'Demasiados mensajes en esta visita.'});return;}
  lastInputTime=now;
  let input=null;
  if(m.type==='text')input=noSecrets(m.text);
  else if(m.type==='intent')input=intentText[m.intent]||null;
  else if(m.type==='repeat')input='Repetí tu presentación breve y recordá que se puede ingresar por voz o por teclado.';
  if(!input){send(ws,'notice',{message:'Decí una sola palabra para la clave, o hablá en una frase para conversar.'});return;}
  try{
   turnOpen=true;
   live.sendClientContent({turns:[{role:'user',parts:[{text:input}]}],turnComplete:true});
  }catch{send(ws,'error',{message:'No pude enviar el mensaje a Gemini Live.'});}
 };
 return {connect,handle,close:stop};
}
function pcmWav(pcm){
 const b=Buffer.alloc(44+pcm.length);
 b.write('RIFF',0);b.writeUInt32LE(36+pcm.length,4);b.write('WAVEfmt ',8);
 b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
 b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);
 b.write('data',36);b.writeUInt32LE(pcm.length,40);pcm.copy(b,44);return b;
}
export async function guardVoiceSample(voice){
 if(!process.env.GEMINI_API_KEY)throw new Error('GEMINI_API_KEY no está configurada');
 const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
 let live,done=false,timer;
 return await new Promise(async(resolve,reject)=>{
  const chunks=[];
  const finish=(err)=>{
   if(done)return;done=true;clearTimeout(timer);try{live?.close()}catch{}
   err?reject(err):resolve(pcmWav(Buffer.concat(chunks)));
  };
  timer=setTimeout(()=>finish(new Error('La prueba de voz excedió el tiempo disponible')),22000);
  try{
   live=await ai.live.connect({model:ERIK_MODEL,config:{
    responseModalities:[Modality.AUDIO],
    speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:availableVoice(voice)}}},
    systemInstruction:{parts:[{text:'Voz natural en español argentino. Pronunciá esta breve frase una sola vez.'}]}
   },callbacks:{
    onopen:()=>{},
    onmessage:m=>{
     for(const part of m.serverContent?.modelTurn?.parts||[])
      if(part.inlineData?.data)chunks.push(Buffer.from(part.inlineData.data,'base64'));
     if(m.serverContent?.turnComplete)finish(chunks.length?null:new Error('Sin audio'));
    },
    onerror:e=>finish(new Error(String(e?.message||e).slice(0,120))),
    onclose:()=>{if(!done)finish(new Error('Sesión de prueba cerrada'))}
   }});
   live.sendClientContent({turns:[{role:'user',parts:[{text:'Hola, soy Erik. Bienvenido a NEXOCV. Te escucho.'}]}],turnComplete:true});
  }catch(err){finish(err);}
 });
}
export function installGuard(app,auth){
 app.get('/api/guard/config',(req,res)=>{
  const s=allSettings();
  res.json({enabled:s.guardEnabled!=='false',model:ERIK_MODEL,voice:availableVoice(s.guardVoice),
   welcome:GUARD_WELCOME,
   frames:Array.from({length:8},(_,i)=>fs.existsSync(path.join(frameDir,i+'.png'))),
   versions:Array.from({length:8},(_,i)=>{try{return Math.round(fs.statSync(path.join(frameDir,i+'.png')).mtimeMs)}catch{return 0}}),
   mouthDelay:s.guardMouthDelay,mouthSensitivity:s.guardMouthSensitivity,
   mouthSmoothing:s.guardMouthSmoothing,mouthAmplitude:s.guardMouthAmplitude,blinkRate:s.guardBlinkRate});
 });
 app.get('/api/guard/frames/:index',async(req,res)=>{
  const i=Number(req.params.index);
  if(!Number.isInteger(i)||i<0||i>7)return res.sendStatus(404);
  const file=path.join(frameDir,i+'.png');
  if(!fs.existsSync(file))return res.sendStatus(404);
  res.set('Cache-Control','public, max-age=300');
  if(req.query.optimized==='1'){
   try{const bytes=await optimizedGuardFrame(i,file);return res.type('webp').send(bytes);}
   catch(e){console.warn('Error optimizando Erik:',String(e.message||e));}
  }
  return res.type('png').sendFile(path.resolve(file));
 });
 app.post('/api/admin/guard/frames/:index',auth('admin'),upload.single('image'),async(req,res)=>{
  const i=Number(req.params.index);
  if(!Number.isInteger(i)||i<0||i>7)return res.sendStatus(404);
  const buf=req.file?.buffer;
  if(!buf||buf.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return res.status(400).json({error:'Subí un PNG.'});
  try{
   const meta=await sharp(buf).metadata();
   if(meta.format!=='png'||!meta.hasAlpha||meta.width<100||meta.height<100||meta.width>4096||meta.height>4096)return res.status(400).json({error:'El PNG debe tener transparencia y medir entre 100 y 4096 píxeles.'});
   for(let other=0;other<8;other++){if(other===i)continue;const reference=path.join(frameDir,other+'.png');if(!fs.existsSync(reference))continue;const m=await sharp(reference).metadata();if(m.width!==meta.width||m.height!==meta.height)return res.status(400).json({error:'Todos los PNG de Erik deben tener el mismo ancho y alto. Referencia: '+m.width+' × '+m.height+' px.'});break;}
   await fs.promises.writeFile(path.join(frameDir,i+'.png'),buf);optimizedCache.delete(i);
   res.json({ok:true,width:meta.width,height:meta.height});
  }catch(e){res.status(400).json({error:'No se pudo procesar el PNG.'});}
 });

 app.post('/api/admin/guard/voice-sample',auth('admin'),async(req,res)=>{
  const voice=String(req.body?.voice||allSettings().guardVoice||'Charon');
  if(!ERIK_VOICES.includes(voice))return res.status(400).json({error:'Voz de Erik no permitida'});
  try{const wav=await guardVoiceSample(voice);res.set('Cache-Control','no-store').type('audio/wav').send(wav);}
  catch(err){res.status(502).json({error:'No se pudo probar la voz de Gemini 3.8 Live: '+String(err.message||err).slice(0,100)})}
 });
}
