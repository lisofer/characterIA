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
