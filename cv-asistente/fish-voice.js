'use strict';
// Fish Audio accepts inline reference audio as raw bytes in MessagePack,
// not a Base64 string inside JSON. Voice-ID requests can use ordinary JSON.
const fs=require('fs');
const path=require('path');
const os=require('os');
const {execFile}=require('child_process');
const {promisify}=require('util');
const {encode}=require('@msgpack/msgpack');
const execFileAsync=promisify(execFile);

function isSupportedAudio(bytes){
 const b=Buffer.from(bytes);
 return (b.subarray(0,4).toString('ascii')==='RIFF'&&b.subarray(8,12).toString('ascii')==='WAVE')
  ||b.subarray(0,3).toString('ascii')==='ID3'
  ||(b.length>2&&b[0]===0xff&&(b[1]&0xe0)===0xe0)
  ||b.subarray(0,4).toString('ascii')==='fLaC';
}
async function normalizeSample(buffer){
 if(!Buffer.isBuffer(buffer)||buffer.length<400||buffer.length>4*1024*1024)throw Error('La muestra debe ser un audio de menos de 4 MB.');
 const folder=await fs.promises.mkdtemp(path.join(os.tmpdir(),'cv-fish-'));
 const input=path.join(folder,'original.audio'),output=path.join(folder,'referencia.wav');
 try{
  await fs.promises.writeFile(input,buffer);
  let duration;
  try{
   const result=await execFileAsync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',input],{timeout:12000});
   duration=Number(result.stdout.trim());
  }catch{throw Error('No pude interpretar el archivo. Probá con MP3, WAV o M4A válido.')}
  if(!Number.isFinite(duration)||duration<3||duration>30)throw Error('La muestra de voz debe durar entre 3 y 30 segundos. Duración detectada: '+(Number.isFinite(duration)?duration.toFixed(1)+' s':'desconocida')+'.');
  await execFileAsync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-i',input,'-vn','-ac','1','-ar','24000','-c:a','pcm_s16le',output],{timeout:20000});
  const wav=await fs.promises.readFile(output);
  if(!isSupportedAudio(wav)||wav.length<10000)throw Error('No se pudo convertir la muestra a WAV.');
  return {buffer:wav,mime:'audio/wav',duration:Math.round(duration*10)/10};
 }finally{await fs.promises.rm(folder,{recursive:true,force:true})}
}

function makeRequest(text,config,assetDirectory,mode='auto'){
 const payload={text,format:'mp3',temperature:config.fish.temperature,top_p:config.fish.topP,prosody:{speed:config.fish.speed,volume:config.fish.volume}};
 const samplePath=path.join(assetDirectory,'voice-sample.bin');
 const sampleText=String(config.voiceSampleText||'').trim();
 const sampleReady=fs.existsSync(samplePath)&&!!sampleText;
 const voiceID=String(config.fish.referenceId||'').trim();
 const source=mode==='auto'?(sampleReady?'sample':voiceID?'id':'default'):mode;
 if(!['sample','id','default'].includes(source))throw Error('Modo de voz no reconocido');
 if(source==='sample'){
  if(!fs.existsSync(samplePath))throw Error('No hay ninguna muestra de voz guardada. Subí un archivo desde Administración.');
  if(!sampleText)throw Error('Falta la transcripción exacta de la muestra. Guardala en Administración.');
  const sample=fs.readFileSync(samplePath);
  if(!isSupportedAudio(sample))throw Error('El archivo de voz guardado no es WAV/MP3 válido. Volvé a subirlo para convertirlo.');
  payload.references=[{audio:new Uint8Array(sample),text:sampleText}];
  return {body:Buffer.from(encode(payload)),contentType:'application/msgpack',source};
 }
 if(source==='id'){
  if(!voiceID)throw Error('No hay un Voice ID configurado en Administración.');
  payload.reference_id=voiceID;
 }
 return {body:Buffer.from(JSON.stringify(payload)),contentType:'application/json',source};
}
function fallbackMessage(source){
 return source==='sample'?'Fish rechazó el audio de muestra. Revisá el audio y su texto exacto en Administración → Voz.':source==='id'?'Fish rechazó el Voice ID. Revisá que corresponda a una voz accesible desde tu cuenta.':'Fish no pudo generar audio sin una voz de referencia.';
}
async function sendFish(req,config,apiKey){
 let response;
 try{
  response=await fetch('https://api.fish.audio/v1/tts',{
   method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':req.contentType,model:config.fish.model},
   body:req.body,signal:AbortSignal.timeout(45000)
  });
 }catch(e){
  throw Error('No se pudo contactar con Fish Audio: '+(e.name==='TimeoutError'?'la solicitud tardó demasiado.':e.message));
 }
 if(!response.ok){
  const body=(await response.text()).slice(0,260);
  const error=new Error('Fish Audio '+response.status+' ('+req.source+'): '+(response.status===400?fallbackMessage(req.source)+' ':'')+body);
  error.status=response.status;
  error.source=req.source;
  error.invalidReference=response.status===400&&/reference|referencia|audio|voice|model id|not found|invalid/i.test(body);
  throw error;
 }
 const audio=Buffer.from(await response.arrayBuffer());
 if(audio.length<100)throw Error('Fish respondió con un audio vacío.');
 return {audio,source:req.source};
}
async function synthesize(text,config,assetDirectory,apiKey,{mode='auto',allowFallback=true}={}){
 const sampleReady=fs.existsSync(path.join(assetDirectory,'voice-sample.bin'))&&!!String(config.voiceSampleText||'').trim();
 const idReady=!!String(config.fish.referenceId||'').trim();
 const first=mode==='auto'?(sampleReady?'sample':idReady?'id':'default'):mode;
 const options=[first];
 if(allowFallback&&mode==='auto'){
  if(first==='sample'&&idReady)options.push('id');
  if(first!=='default')options.push('default');
 }
 let lastError=null;
 for(const source of options){
  try{
   const req=makeRequest(text,config,assetDirectory,source);
   const result=await sendFish(req,config,apiKey);
   return {...result,fallbackFrom:source!==first?first:null};
  }catch(e){
   lastError=e;
   if(!e.invalidReference||source===options.at(-1))throw e;
   console.warn('Fish: referencia rechazada; probando otra fuente:',source,'status',e.status);
  }
 }
 throw lastError||Error('No se pudo sintetizar la voz');
}
module.exports={isSupportedAudio,normalizeSample,makeRequest,synthesize};
