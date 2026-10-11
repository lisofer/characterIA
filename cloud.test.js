'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'persona-cloud-test-'));
process.env.CLOUD_ALLOW_DEV_DISK='1';
process.env.PERSISTENT_DATA_DIR=directory;
const cloud=require('./cloud-store');
after(()=>fs.rmSync(directory,{recursive:true,force:true}));
test('requiere almacenamiento persistente explícito; modo de prueba activo',()=>{
 assert.equal(cloud.status().available,true);
 assert.deepEqual(cloud.readState(),{revision:0,state:null,updatedAt:null});
});
test('archivos binarios con firma SHA256 y recuperación intacta',()=>{
 const data=Buffer.from('PNG o referencia Fish de ejemplo');
 const hash=crypto.createHash('sha256').update(data).digest('hex');
 assert.deepEqual(cloud.putAsset(hash,data),{hash,size:data.length});
 assert.deepEqual(cloud.getAsset(hash),data);
 assert.throws(()=>cloud.putAsset('a'.repeat(64),data),/firma/);
 assert.equal(cloud.putAsset(hash,data).hash,hash);
});
test('metadata atómica, versiones y detección de cambios concurrentes',()=>{
 const data=Buffer.from('Sprite');
 const hash=crypto.createHash('sha256').update(data).digest('hex');
 const state={schema:1,kv:{'persona-studio-profile-index-v3':'[{"id":"p1","name":"Roro"}]',
  'persona-studio-duels-v1':'{"topics":[]}'},
  assets:{'p1:idleOpen':{hash,type:'image/png',size:data.length}}};
 assert.throws(()=>cloud.updateState({baseRevision:0,state}),/Falta subir/);
 cloud.putAsset(hash,data);
 const rev=cloud.updateState({baseRevision:0,state});
 assert.equal(rev.revision,1);
 const read=cloud.readState();
 assert.equal(read.revision,1);
 assert.equal(read.state.kv['persona-studio-profile-index-v3'],state.kv['persona-studio-profile-index-v3']);
 assert.equal(read.state.assets['p1:idleOpen'].hash,hash);
 assert.throws(()=>cloud.updateState({baseRevision:0,state}),e=>e.status===409);
 assert.equal(cloud.updateState({baseRevision:1,state}).revision,2);
 const disk=JSON.parse(fs.readFileSync(path.join(directory,'persona-studio-cloud-v1','state.json'),'utf8'));
 assert.equal(disk.revision,2);
});
test('rechaza claves inesperadas y rutas maliciosas',()=>{
 const valid={schema:1,kv:{bad:'value'},assets:{}};
 assert.throws(()=>cloud.updateState({baseRevision:2,state:valid}),e=>e.status===400);
 assert.throws(()=>cloud.getAsset('../state.json'),e=>e.status===400);
 assert.throws(()=>cloud.getAsset('f'.repeat(64)),e=>e.status===404);
});

test('admite música de más de 20 MB sin ampliar el límite de los demás archivos',()=>{
 const bytes=Buffer.alloc(20000001,0x41);
 const hash=crypto.createHash('sha256').update(bytes).digest('hex');
 assert.equal(cloud.putAsset(hash,bytes).size,bytes.length);
 const before=cloud.readState().revision;
 const music={schema:1,kv:{},assets:{'music:background':{hash,type:'audio/mpeg',size:100*1024*1024}}};
 assert.equal(cloud.updateState({baseRevision:before,state:music}).revision,before+1);
 assert.throws(()=>cloud.updateState({baseRevision:before+1,state:{schema:1,kv:{},assets:{'music:background':{hash,type:'audio/mpeg',size:100*1024*1024+1}}}}),/Manifiesto/);
 assert.throws(()=>cloud.updateState({baseRevision:before+1,state:{schema:1,kv:{},assets:{'p1:idleOpen':{hash,type:'image/png',size:20000001}}}}),/Manifiesto/);
});

test('archivos de música de la biblioteca mantienen el límite de 100 MB',()=>{
 const data=Buffer.alloc(20000001,0x37);
 const hash=crypto.createHash('sha256').update(data).digest('hex');
 cloud.putAsset(hash,data);
 const start=cloud.readState().revision;
 const state={schema:1,kv:{},assets:{'music:track:t_example':{hash,type:'audio/mpeg',size:data.length}}};
 assert.equal(cloud.updateState({baseRevision:start,state}).revision,start+1);
 assert.throws(()=>cloud.updateState({baseRevision:start+1,
  state:{schema:1,kv:{},assets:{'music:track:t_large':{hash,type:'audio/mpeg',size:104857601}}}}),/Manifiesto/);
 assert.throws(()=>cloud.updateState({baseRevision:start+1,
  state:{schema:1,kv:{},assets:{'p1:voiceSample':{hash,type:'audio/mpeg',size:data.length}}}}),/Manifiesto/);
});


test('sincroniza el prompt general del debate sin perder otros datos',()=>{
 const old=cloud.readState();
 const prior=old.state||{schema:1,kv:{},assets:{}};
 const key='persona-studio-duel-general-prompt-v1';
 const prompt='Escuchá al moderador, reaccioná al chat y entretené al público.';
 const next={schema:1,kv:{...prior.kv,[key]:prompt},assets:{...prior.assets}};
 const updated=cloud.updateState({baseRevision:old.revision,state:next});
 const stored=cloud.readState();
 assert.equal(stored.revision,updated.revision);
 assert.equal(stored.state.kv[key],prompt);
 for(const [k,v] of Object.entries(prior.kv))assert.equal(stored.state.kv[k],v);
 assert.deepEqual(stored.state.assets,prior.assets);
 assert.throws(()=>cloud.updateState({baseRevision:updated.revision,
   state:{...next,kv:{...next.kv,'clave-desconocida':'no'}}}),e=>e.status===400);
});
