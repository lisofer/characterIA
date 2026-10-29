import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import multer from 'multer';
import {rateLimit} from 'express-rate-limit';
import {GoogleGenAI} from '@google/genai';
import {encode} from '@msgpack/msgpack';
import crypto from 'node:crypto';
import {DATA_DIR,allSettings} from './db.js';

const frameDir=path.join(DATA_DIR,'guard-frames');
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
const refAudioFile=path.join(DATA_DIR,'guard-voice-reference.bin');
const refMetadataFile=path.join(DATA_DIR,'guard-voice-reference.json');
const hasReference=()=>fs.existsSync(refAudioFile)&&fs.existsSync(refMetadataFile);
const getReference=()=>{if(!hasReference())return null;try{const j=JSON.parse(fs.readFileSync(refMetadataFile,'utf8'));return {...j,audio:fs.readFileSync(refAudioFile)};}catch{return null;}};
fs.mkdirSync(frameDir,{recursive:true});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1}});
const limited=rateLimit({windowMs:60_000,limit:14,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Demasiadas solicitudes de voz. Intentá de nuevo en un minuto.'}});
// Estas situaciones son funcionales, no un segundo prompt de personalidad.
// La personalidad completa que se envía al modelo es la visible y editable en Admin.
const intents={
 greeting:'Alguien acaba de llegar al acceso. Saludá como Erik y pedí la contraseña.',
 ask:'La persona está lista para dar la contraseña. Pedila en una sola intervención.',
 retry:'El servidor rechazó el acceso. Pedí otro intento sin sugerir ni revelar contraseñas.',
 help:'Explicá que puede decir su contraseña en voz alta si está en un lugar privado o escribirla.',
 listening:'Indicá que estás escuchando y que puede hablar cuando quiera.',
 goodbye:'La conversación se termina. Despedite de forma breve.',
 permission:'El navegador no habilitó el audio o micrófono. Explicá cómo activarlo o entrar por teclado.'
};
const fallbacks={
 greeting:[
  'Alto ahí. Soy Erik, jefe de esta importantísima puerta. ¿Contraseña?',
  'Buenas. Soy Erik, encargado de que no entre cualquiera. Decime la contraseña.',
  'Se abre la oficina de seguridad. Yo soy Erik. ¿Tenés contraseña?',
  'A ver, a ver... ¿quién quiere pasar? Primero la contraseña.',
  'Soy Erik. Mi trabajo es custodiar una puerta digital. Bueno, decime la contraseña.'
 ],
 ask:[
  'Acá sigo, custodiando la puerta. Dale, decime la contraseña.',
  'A ver qué tenemos. Te escucho: ¿cuál es la contraseña?',
  'El puesto de control está listo. Decime tu clave.',
  'Bueno, llega el momento solemne: la contraseña.',
  'Procedamos con el gran trámite de seguridad. Te escucho.'
 ],
 retry:[
  '¡Apa! Esa clave se presentó sin autorización. Dame otra.',
  'Mi detector de accesos hizo una mueca. Decime otra contraseña.',
  'El reglamento imaginario acaba de levantar una ceja. Intentá de nuevo.',
  'No, señor. El comité de una sola persona, o sea yo, rechazó el intento.',
  'Mi sistema de seguridad acaba de poner cara rara. Probá otra clave.',
  'Inspección sorpresa: esta combinación no pasó. Decime otra.',
  'La computadora se hizo la misteriosa. Necesito otro intento.',
  'Increíble. Me tocó trabajar de verdad. Dame otra contraseña.',
  'Esa clave no superó la revisión de mi importantísimo escritorio.',
  'Mi placa de SECURITY dice que todavía no. Te escucho otra vez.',
  'Esa combinación quedó retenida en la aduana digital. Intentá de nuevo.',
  'El acceso sigue en huelga. Necesito otra contraseña.',
  'Negativo. Me obligás a levantar un formulario invisible. Otra clave.',
  'Esa contraseña no pasó el examen de portería. A ver la siguiente.'
 ],
 help:[
  'Podés decir la contraseña en voz alta si estás en privado, o escribirla en el campo.',
  'No hace falta leer nada: hablame en privado o usá el teclado si preferís.',
  'Te escucho por voz. Si hay gente cerca, mejor escribí la contraseña.'
 ],
 listening:[
  'Estoy escuchando. Decime la contraseña cuando quieras.',
  'Micrófono listo. Te presto mis importantísimos oídos.',
  'Acá estoy. Decime la clave cuando estés listo.',
  'Adelante, te escucho. No me hagas poner solemne.',
  'Control de acceso preparado. Te escucho.'
 ],
 goodbye:[
  'Bueno, cierro la ventanilla. Nos vemos.',
  'Se suspende mi importantísima guardia. Chau.',
  'Fin del operativo puerta. Hasta luego.'
 ],
 permission:[
  'Tocame para activar el micrófono, o escribí tu contraseña.',
  'El navegador no me dejó escuchar. Tocame o usá el teclado.',
  'Necesito permiso del micrófono. Si no, podés escribir la clave.'
 ]
};
// Contexto efímero por visita: solo frases producidas por Erik, jamás contraseñas.
const dialogSessions=new Map();
const SESSION_MAX=350, SESSION_TTL_MS=25*60*1000;
function dialogContext(id){
 const valid=typeof id==='string'&&/^[a-zA-Z0-9_-]{20,80}$/.test(id);
 const key=valid?id:crypto.randomUUID();
 const now=Date.now();
 if(dialogSessions.size>SESSION_MAX){
  for(const [k,v] of dialogSessions)if(v.updated<now-SESSION_TTL_MS)dialogSessions.delete(k);
  while(dialogSessions.size>SESSION_MAX)dialogSessions.delete(dialogSessions.keys().next().value);
 }
 let context=dialogSessions.get(key);
 if(!context||context.updated<now-SESSION_TTL_MS){context={recent:[],updated:now};dialogSessions.set(key,context);}
 context.updated=now;
 return context;
}
function normalizePhrase(value){
 return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
}
function tooSimilar(value,recent){
 const candidate=normalizePhrase(value);
 if(!candidate)return true;
 const words=new Set(candidate.split(' ').filter(w=>w.length>3));
 return recent.some(previous=>{
  const prev=normalizePhrase(previous);
  if(prev===candidate||prev.includes(candidate)||candidate.includes(prev))return true;
  const previousWords=new Set(prev.split(' ').filter(w=>w.length>3));
  if(words.size<3||previousWords.size<3)return false;
  let overlap=0;for(const w of words)if(previousWords.has(w))overlap++;
  return overlap/Math.min(words.size,previousWords.size)>.78;
 });
}
function rememberLine(ctx,line){
 ctx.recent.push(line);
 if(ctx.recent.length>7)ctx.recent.shift();
 ctx.updated=Date.now();
 return line;
}
function chooseFallback(intent,ctx){
 const pool=fallbacks[intent]||fallbacks.ask;
 const options=pool.filter(x=>!tooSimilar(x,ctx.recent));
 const choices=options.length?options:pool.filter(x=>normalizePhrase(x)!==normalizePhrase(ctx.recent.at(-1)));
 return rememberLine(ctx,(choices.length?choices:pool)[crypto.randomInt((choices.length?choices:pool).length)]);
}
function finite(n,def,min,max){const x=Number(n);return Number.isFinite(x)?Math.max(min,Math.min(max,x)):def;}
async function phrase(intent,sessionId){
 const ctx=dialogContext(sessionId);
 const s=allSettings();
 const persona=String(s.guardPrompt||'').trim();
 if(!process.env.GEMINI_API_KEY||!persona)return chooseFallback(intent,ctx);
 try{
  const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
  const recent=ctx.recent.slice(-6);
  const instructions=[
   'PERSONALIDAD EDITABLE DEL PORTERO (guardPrompt en Admin):',persona,
   'SITUACIÓN OPERATIVA ACTUAL:',intents[intent],
   ...(intent==='greeting'?['SALUDO DE REFERENCIA (no es un audio obligatorio; podés improvisar):',String(s.guardGreeting||'').slice(0,350)]:[]),
   'INTERVENCIONES QUE ERIK YA DIJO EN ESTA VISITA (evitá repetir las palabras, el chiste y la estructura):',
   recent.length?recent.map((x,i)=>String(i+1)+'. '+x).join('\n'):'Ninguna todavía.',
   'RESTRICCIONES OPERATIVAS: Escribí una única intervención espontánea en español argentino de máximo 28 palabras. Una sola pregunta como máximo. Cambiá el recurso humorístico, el comienzo y el ritmo de cada frase; no recicles una plantilla. No uses «eso no abrió la puerta», ni variantes de ese remate. Nunca reveles ni inventes contraseñas ni afirmes que el acceso fue aprobado. No trates mal a nadie ni impidas el acceso. Solo devolvé lo que diría Erik, sin comillas, etiquetas ni explicaciones.'
  ].join('\n\n');
  const result=await ai.models.generateContent({
   model:'gemini-2.5-flash',
   contents:instructions,
   config:{temperature:1.05,maxOutputTokens:140}
  });
  const cleaned=String(result.text||'').replace(/[\r\n]+/g,' ')
   .replace(/^[\s"'“”]+|[\s"'“”]+$/g,'').trim().slice(0,250);
  // Evitar respuestas enlatadas incluso si el modelo insiste en repetirlas.
  const canned=/(?:eso|esa|la clave).{0,30}(?:no abri[oó] la puerta|no abre la puerta)/i.test(cleaned);
  if(!cleaned||canned||tooSimilar(cleaned,ctx.recent))return chooseFallback(intent,ctx);
  return rememberLine(ctx,cleaned);
 }catch(err){
  // No exponer claves de API ni datos del usuario en los registros.
  console.warn('Erik: generación de respuesta no disponible, usando alternativa:',String(err?.name||'error').slice(0,50));
  return chooseFallback(intent,ctx);
 }
}
async function fishAudio(text,s){
 if(!process.env.FISH_API_KEY)throw new Error('Configurá FISH_API_KEY en las variables de Railway.');
 const voice=String(s.guardVoiceId||'').trim();
 const savedReference=!voice?getReference():null;
 if(!voice&&!savedReference)throw new Error('Configurá un ID de voz Fish o subí un audio de referencia con su transcripción en Admin > Erik.');
 const model=['s2.1-pro-free','s2.1-pro','s2-pro'].includes(s.guardFishModel)?s.guardFishModel:'s2.1-pro-free';
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);
 const payload={text,format:'mp3',temperature:finite(s.guardTemperature,.7,0,1),top_p:finite(s.guardTopP,.7,0,1),prosody:{speed:finite(s.guardSpeed,1,.7,1.5)}};
 if(voice)payload.reference_id=voice;
 else payload.references=[{audio:new Uint8Array(savedReference.audio),text:savedReference.text}];
 const useMsgpack=!voice;
 try{
  const response=await fetch('https://api.fish.audio/v1/tts',{
   method:'POST',
   headers:{Authorization:'Bearer '+process.env.FISH_API_KEY,'Content-Type':useMsgpack?'application/msgpack':'application/json',model},
   body:useMsgpack?encode(payload):JSON.stringify(payload),
   signal:controller.signal
  });
  if(!response.ok){
   let details='';
   try{
    const content=await response.text();
    const parsed=JSON.parse(content);
    details=String(parsed.message||parsed.error||parsed.detail||'').slice(0,220);
   }catch{}
   // No registrar la clave ni el texto solicitado al proveedor en los logs.
   console.warn('Fish Audio HTTP',response.status,'modelo',model);
   if(response.status===402)throw new Error(model==='s2.1-pro-free'
    ?'Fish Audio devolvió 402 también para S2.1 Pro Free. Revisá en fish.audio/app/developers que tu cuenta tenga acceso a la API gratuita.'
    :'Fish Audio: saldo insuficiente o facturación pendiente (HTTP 402). Elegí S2.1 Pro Free en Admin > Erik para probar sin cargar créditos.');
   if(response.status===401||response.status===403)
    throw new Error('Fish Audio rechazó la autenticación (HTTP '+response.status+'). Revisá FISH_API_KEY en Railway, sin pegarla aquí.');
   if(response.status===429)throw new Error('Fish Audio limitó las solicitudes (HTTP 429). Esperá unos instantes y volvé a probar.');
   if(response.status===400||response.status===422)
    throw new Error('Fish Audio rechazó la solicitud (HTTP '+response.status+'). Revisá la voz, el audio de referencia y el modelo.'+(details?' Detalle: '+details:''));
   throw new Error('Fish Audio respondió HTTP '+response.status+(details?': '+details:'')+'.');
  }
  const type=response.headers.get('content-type')||'';
  if(!/audio|octet-stream/i.test(type))throw new Error('Fish Audio no devolvió audio.');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(!bytes.length||bytes.length>4_000_000)throw new Error('Respuesta de audio inválida.');
  return bytes;
 }finally{clearTimeout(timer);}
}
function publicConfig(){
 const s=allSettings();
 return {enabled:s.guardEnabled!=='false',
  frames:Array.from({length:8},(_,i)=>fs.existsSync(path.join(frameDir,i+'.png'))),
  versions:Array.from({length:8},(_,i)=>{try{return Math.round(fs.statSync(path.join(frameDir,i+'.png')).mtimeMs);}catch{return 0;}}),
  mouthDelay:s.guardMouthDelay,mouthSensitivity:s.guardMouthSensitivity,mouthSmoothing:s.guardMouthSmoothing,
  mouthAmplitude:s.guardMouthAmplitude,blinkRate:s.guardBlinkRate,fishReady:!!(process.env.FISH_API_KEY&&(s.guardVoiceId||hasReference()))};
}
export function installGuard(app,auth){
 app.get('/api/admin/guard/voice-reference',auth('admin'),(req,res)=>{
  const info=getReference();res.json(info?{exists:true,name:info.name,text:info.text}:{exists:false});
 });
 app.post('/api/admin/guard/voice-reference',auth('admin'),upload.single('audio'),async(req,res)=>{
  const file=req.file,words=String(req.body?.text||'').trim();
  if(!file||file.size<1000||file.size>8*1024*1024||words.length<3||words.length>1500)return res.status(400).json({error:'Subí un audio menor a 8 MB e indicá exactamente qué se dice en él.'});
  const b=file.buffer,head=b.subarray(0,12).toString('latin1');
  const wav=head.startsWith('RIFF')&&head.includes('WAVE'),flac=head.startsWith('fLaC'),mp3=head.startsWith('ID3')||(b[0]===255&&(b[1]&224)===224);
  if(!wav&&!flac&&!mp3)return res.status(400).json({error:'El audio debe ser WAV, FLAC o MP3.'});
  try{
   await fs.promises.writeFile(refAudioFile,b);
   const info={name:String(file.originalname||'audio').slice(0,120),text:words,uploadedAt:new Date().toISOString()};
   await fs.promises.writeFile(refMetadataFile,JSON.stringify(info));
   return res.json({ok:true,exists:true,name:info.name,text:info.text});
  }catch{return res.status(500).json({error:'No se pudo guardar el audio en el volumen persistente.'});}
 });
 app.get('/api/guard/config',(req,res)=>res.json(publicConfig()));
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
 app.post('/api/guard/line',limited,async(req,res)=>{
  const intent=String(req.body?.intent||'');
  if(!Object.hasOwn(intents,intent))return res.status(400).json({error:'Comando no válido.'});
  if(allSettings().guardEnabled==='false')return res.status(404).json({error:'Erik desactivado.'});
  const text=await phrase(intent,req.body?.sessionId);
  const s=allSettings();
  if(!process.env.FISH_API_KEY||(!s.guardVoiceId&&!hasReference()))return res.json({text,engine:'browser'});
  try{const audio=await fishAudio(text,s);return res.json({text,engine:'fish',mime:'audio/mpeg',audio:audio.toString('base64')});}
  catch(e){console.warn('Erik TTS:',String(e.message||e));return res.json({text,engine:'browser'});}
 });
 app.post('/api/admin/guard/voice-sample',auth('admin'),rateLimit({windowMs:60_000,limit:6}),async(req,res)=>{
  const s=allSettings();
  const text=String(req.body?.text||s.guardSampleText||'Hola, soy Erik. ¿Cuál es la contraseña?').trim().slice(0,350);
  if(!text)return res.status(400).json({error:'Escribí un texto para la muestra.'});
  try{const bytes=await fishAudio(text,{...s,guardVoiceId:String(req.body?.voiceId||s.guardVoiceId||'').trim(),
   guardTemperature:req.body?.temperature??s.guardTemperature,guardTopP:req.body?.topP??s.guardTopP,
   guardSpeed:req.body?.speed??s.guardSpeed,guardFishModel:req.body?.model||s.guardFishModel});
   res.set('Cache-Control','no-store');res.type('audio/mpeg').send(bytes);
  }catch(e){res.status(502).json({error:String(e.message||e)});}
 });
}
