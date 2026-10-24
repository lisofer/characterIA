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
function makeRequest(text,config,assetDirectory){
 const payload={text,format:'mp3',temperature:config.fish.temperature,top_p:config.fish.topP,prosody:{speed:config.fish.speed,volume:config.fish.volume}};
 const samplePath=path.join(assetDirectory,'voice-sample.bin');
 const sampleText=String(config.voiceSampleText||'').trim();
 if(fs.existsSync(samplePath)&&sampleText){
  const sample=fs.readFileSync(samplePath);
  if(!isSupportedAudio(sample))throw Error('La muestra guardada no está en un formato válido para Fish. Volvé a cargarla en Administración → Voz.');
  if(sampleText.length<3)throw Error('Escribí el texto exacto de la muestra en Administración → Voz.');
  payload.references=[{audio:new Uint8Array(sample),text:sampleText}];
  return {body:Buffer.from(encode(payload)),contentType:'application/msgpack',source:'sample'};
 }
 if(config.fish.referenceId)payload.reference_id=config.fish.referenceId;
 return {body:Buffer.from(JSON.stringify(payload)),contentType:'application/json',source:config.fish.referenceId?'id':'default'};
}
async function synthesize(text,config,assetDirectory,apiKey){
 const request=makeRequest(text,config,assetDirectory);
 let response;
 try{
  response=await fetch('https://api.fish.audio/v1/tts',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':request.contentType,model:config.fish.model},body:request.body,signal:AbortSignal.timeout(60000)});
 }catch(e){throw Error('No se pudo contactar con Fish Audio: '+(e.name==='TimeoutError'?'la conexión tardó demasiado.':e.message))}
 if(!response.ok){
  const body=(await response.text()).slice(0,250);
  if(response.status===400&&request.source==='sample')throw Error('Fish rechazó el audio de referencia. Comprobá que la muestra contenga voz clara y que su transcripción coincida exactamente. Probá subirla de nuevo. '+body);
  if(response.status===400&&request.source==='id')throw Error('Fish rechazó el ID de la voz configurada. Revisalo en Administración → Voz. '+body);
  throw Error('Fish Audio '+response.status+': '+body);
 }
 const data=Buffer.from(await response.arrayBuffer());
 if(data.length<100)throw Error('Fish devolvió un audio vacío.');
 return {audio:data,source:request.source};
}
module.exports={isSupportedAudio,normalizeSample,makeRequest,synthesize};
