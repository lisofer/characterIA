'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {merge,meaningful}=require('./cloud-merge');
const PRO='persona-studio-profiles-v3', IDX='persona-studio-profile-index-v3';
const DUEL='persona-studio-duels-v1',BG='persona-studio-backgrounds-v1';
function snapshot(name='Mi personaje',persona='',hash=null){
 const id='default';
 return {schema:1,kv:{
  [PRO]:JSON.stringify({[id]:{settings:{characterName:name,persona},history:[]}}),
  [IDX]:JSON.stringify([{id,name}]),
  [DUEL]:JSON.stringify({topics:[],activeId:null}),
  [BG]:'[]'
 },assets:hash?{'default:idleOpen':{hash,type:'image/png',size:100}}:{}};
}
function profiles(s){return JSON.parse(s.kv[PRO])}
function names(s){return JSON.parse(s.kv[IDX])}
test('El perfil vacío de una computadora no borra al del celular',()=>{
 const phone=snapshot('Patrick Jane','Mentalista ingenioso','a'.repeat(64));
 const pc=snapshot();
 assert.equal(meaningful(pc),false);
 assert.deepEqual(merge(phone,pc).state,phone);
 assert.equal(merge(pc,phone).forks,0);
});
test('Una personalidad nueva se aplica sin crear copias cuando nadie más la tocó',()=>{
 const initial=snapshot('Roro','Versión 1','a'.repeat(64));
 const edited=snapshot('Roro','Versión 2','a'.repeat(64));
 const next=merge(initial,edited,{base:initial});
 assert.equal(next.forks,0);
 assert.equal(profiles(next.state).default.settings.persona,'Versión 2');
 assert.equal(names(next.state).length,1);
});
test('Cambiar una imagen conserva la identidad del personaje',()=>{
 const initial=snapshot('Roro','Influencer','a'.repeat(64));
 const edited=snapshot('Roro','Influencer','b'.repeat(64));
 const next=merge(initial,edited,{base:initial});
 assert.equal(next.forks,0);
 assert.equal(next.state.assets['default:idleOpen'].hash,'b'.repeat(64));
});
test('Un conflicto real entre dos celulares conserva ambas variantes y ambas imágenes',()=>{
 const pc=snapshot('Patrick Jane','Mentalista','a'.repeat(64));
 const phone=snapshot('Roro','Creativa','b'.repeat(64));
 const result=merge(pc,phone);
 assert.equal(names(result.state).length,2);
 assert.equal(Object.values(result.state.assets).length,2);
 assert.equal(Object.keys(profiles(result.state)).length,2);
});
test('No modifica ni el original remoto ni el local',()=>{
 const pc=snapshot('Patrick','A','a'.repeat(64));
 const phone=snapshot('Roro','B','b'.repeat(64));
 const beforeA=JSON.stringify(pc),beforeB=JSON.stringify(phone);
 merge(pc,phone);
 assert.equal(JSON.stringify(pc),beforeA);
 assert.equal(JSON.stringify(phone),beforeB);
});
const GLOBAL='persona-studio-global-v3',MUSIC='music:background';
const musicCfg=(name,time)=>JSON.stringify({music:{name,size:100,updatedAt:time,volume:18,duck:22}});
const musicAsset=(letter)=>({hash:letter.repeat(64),type:'audio/mpeg',size:100});
test('La pista más reciente reemplaza la anterior sin duplicados',()=>{
 const remote=snapshot();remote.kv[GLOBAL]=musicCfg('vieja.mp3',100);remote.assets[MUSIC]=musicAsset('a');
 const newer={schema:1,kv:{[GLOBAL]:musicCfg('nueva.mp3',200)},assets:{[MUSIC]:musicAsset('b')}};
 const result=merge(remote,newer,{base:remote}).state;
 assert.equal(result.assets[MUSIC].hash,'b'.repeat(64));
 assert.equal(Object.keys(result.assets).filter(k=>k.includes('music')).length,1);
 assert.equal(JSON.parse(result.kv[GLOBAL]).music.name,'nueva.mp3');
});
test('Borrar la música también se sincroniza',()=>{
 const remote=snapshot();remote.kv[GLOBAL]=musicCfg('vieja.mp3',100);remote.assets[MUSIC]=musicAsset('a');
 const removed={schema:1,kv:{[GLOBAL]:musicCfg('',300)},assets:{}};
 const result=merge(remote,removed,{base:remote}).state;
 assert.equal(result.assets[MUSIC],undefined);
 assert.equal(JSON.parse(result.kv[GLOBAL]).music.name,'');
});
test('Una versión vieja de otro dispositivo no reemplaza la canción nueva',()=>{
 const original=snapshot();original.kv[GLOBAL]=musicCfg('vieja.mp3',100);original.assets[MUSIC]=musicAsset('a');
 const remote=snapshot();remote.kv[GLOBAL]=musicCfg('nueva.mp3',400);remote.assets[MUSIC]=musicAsset('b');
 const stale={schema:1,kv:{[GLOBAL]:musicCfg('',250)},assets:{}};
 const result=merge(remote,stale,{base:original}).state;
 assert.equal(result.assets[MUSIC].hash,'b'.repeat(64));
 assert.equal(JSON.parse(result.kv[GLOBAL]).music.name,'nueva.mp3');
});
