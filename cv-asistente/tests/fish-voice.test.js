'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {decode}=require('@msgpack/msgpack');
const {makeRequest,isSupportedAudio}=require('../fish-voice');
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
