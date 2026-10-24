'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {decode}=require('@msgpack/msgpack');
const {makeRequest,isSupportedAudio,synthesize}=require('../fish-voice');
const config={fish:{model:'s2.1-pro-free',referenceId:'voice-123',temperature:.7,topP:.7,speed:1,volume:0},voiceSampleText:'Una muestra de voz clara.'};
test('sin muestra: Fish recibe JSON con reference_id',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-test-'));
 try{const req=makeRequest('Hola',config,dir);assert.equal(req.contentType,'application/json');assert.equal(JSON.parse(req.body.toString()).reference_id,'voice-123')}finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('con muestra: Fish recibe MessagePack con bytes de audio (no Base64)',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-test-'));
 const buffer=Buffer.alloc(1000);buffer.write('RIFF',0);buffer.write('WAVE',8);
 try{fs.writeFileSync(path.join(dir,'voice-sample.bin'),buffer);
 const req=makeRequest('Hola',config,dir);
 assert.equal(req.contentType,'application/msgpack');
 assert.equal(req.source,'sample');
 const value=decode(req.body);
 assert.equal(value.references[0].text,config.voiceSampleText);
 assert.deepEqual(Buffer.from(value.references[0].audio),buffer);
 assert.ok(!Object.hasOwn(value,'reference_id'));
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('muestra antigua en formato inválido: mensaje para recargar',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-test-'));
 try{fs.writeFileSync(path.join(dir,'voice-sample.bin'),Buffer.from('esto no es audio'));
 assert.throws(()=>makeRequest('Hola',config,dir),/Volvé a cargarla/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('si Fish rechaza muestra e ID, modo automático utiliza la voz por defecto',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-fallback-'));
 const sample=Buffer.alloc(1000);sample.write('RIFF',0);sample.write('WAVE',8);
 fs.writeFileSync(path.join(dir,'voice-sample.bin'),sample);
 const oldFetch=global.fetch,seen=[];
 try{
  global.fetch=async(_url,args)=>{
   seen.push(args.headers['Content-Type']);
   if(seen.length<3)return {ok:false,status:400,text:async()=>JSON.stringify({message:'Reference Audio is not valid'})};
   return {ok:true,arrayBuffer:async()=>Uint8Array.from({length:220},(_,i)=>i%256).buffer};
  };
  const result=await synthesize('Hola',config,dir,'test-key');
  assert.deepEqual(seen,['application/msgpack','application/json','application/json']);
  assert.equal(result.source,'default');assert.equal(result.fallbackFrom,'sample');assert.equal(result.audio.length,220);
 }finally{global.fetch=oldFetch;fs.rmSync(dir,{recursive:true,force:true})}
});
test('prueba exclusiva de una muestra falla sin cambiar silenciosamente de voz',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-fail-'));
 const sample=Buffer.alloc(1000);sample.write('RIFF',0);sample.write('WAVE',8);
 fs.writeFileSync(path.join(dir,'voice-sample.bin'),sample);
 const oldFetch=global.fetch;let attempts=0;
 try{
  global.fetch=async()=>{attempts++;return {ok:false,status:400,text:async()=>JSON.stringify({message:'Reference Audio is not valid'})}};
  await assert.rejects(synthesize('Hola',config,dir,'test-key',{mode:'sample',allowFallback:false}),/Fish rechazó el audio/);
  assert.equal(attempts,1);
 }finally{global.fetch=oldFetch;fs.rmSync(dir,{recursive:true,force:true})}
});
