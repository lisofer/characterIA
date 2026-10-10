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