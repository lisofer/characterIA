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

const MUSIC_GLOBAL='persona-studio-global-v3';
function musicState(tracks,selectedId='',time=0,hashes={}){
 const st=snapshot();
 st.kv[MUSIC_GLOBAL]=JSON.stringify({music:{tracks,selectedId,volume:18,duck:22,settingsUpdatedAt:time}});
 for(const [id,hash] of Object.entries(hashes))st.assets[id==='legacy'?'music:background':'music:track:'+id]=
  {hash:hash.repeat(64),type:'audio/mpeg',size:1024};
 return st;
}
const track=(id,name,when,removed=false)=>({id,name,size:1024,addedAt:when,updatedAt:when,...(removed?{deletedAt:when}:{})});
test('Permite varias canciones y conserva la anterior al agregar otra',()=>{
 const first=musicState([track('t_one','Primera',10)],'t_one',10,{t_one:'a'});
 const next=musicState([track('t_two','Segunda',20)],'t_two',20,{t_two:'b'});
 const merged=merge(first,next,{base:first}).state;
 assert.deepEqual(JSON.parse(merged.kv[MUSIC_GLOBAL]).music.tracks.map(t=>t.name),['Primera','Segunda']);
 assert.ok(merged.assets['music:track:t_one']);
 assert.ok(merged.assets['music:track:t_two']);
 assert.equal(JSON.parse(merged.kv[MUSIC_GLOBAL]).music.selectedId,'t_two');
});
test('Renombrar una pista mantiene el archivo y no duplica el ID',()=>{
 const first=musicState([track('t_one','Antes',10)],'t_one',10,{t_one:'a'});
 const edited=musicState([track('t_one','Después',30)],'t_one',10,{t_one:'a'});
 const merged=merge(first,edited,{base:first}).state;
 assert.equal(JSON.parse(merged.kv[MUSIC_GLOBAL]).music.tracks.length,1);
 assert.equal(JSON.parse(merged.kv[MUSIC_GLOBAL]).music.tracks[0].name,'Después');
 assert.equal(merged.assets['music:track:t_one'].hash,'a'.repeat(64));
});
test('Los borrados se propagan y no reaparecen al sincronizar dispositivos',()=>{
 const first=musicState([track('t_one','Borrar',10)],'t_one',10,{t_one:'a'});
 const removed=musicState([track('t_one','Borrar',30,true)],'',30,{});
 const merged=merge(first,removed,{base:first}).state;
 assert.equal(merged.assets['music:track:t_one'],undefined);
 assert.ok(JSON.parse(merged.kv[MUSIC_GLOBAL]).music.tracks[0].deletedAt);
});
test('Otro dispositivo desactualizado no borra una canción editada posteriormente',()=>{
 const base=musicState([track('t_one','Viejo',10)],'t_one',10,{t_one:'a'});
 const remote=musicState([track('t_one','Más nuevo',90)],'t_one',90,{t_one:'b'});
 const stale=musicState([track('t_one','Viejo',40,true)],'',40,{});
 const merged=merge(remote,stale,{base}).state;
 assert.equal(merged.assets['music:track:t_one'].hash,'b'.repeat(64));
 assert.equal(JSON.parse(merged.kv[MUSIC_GLOBAL]).music.tracks[0].name,'Más nuevo');
});
test('La pista anterior sigue disponible al crear la biblioteca nueva',()=>{
 const legacy=snapshot();
 legacy.kv[MUSIC_GLOBAL]=JSON.stringify({music:{name:'Canción antigua.mp3',size:1024,updatedAt:10}});
 legacy.assets['music:background']={hash:'a'.repeat(64),type:'audio/mpeg',size:1024};
 const newer=musicState([track('t_new','Nueva',90)],'t_new',90,{t_new:'b'});
 const merged=merge(legacy,newer,{base:legacy}).state;
 assert.equal(JSON.parse(merged.kv[MUSIC_GLOBAL]).music.tracks.length,2);
 assert.ok(merged.assets['music:background']);
 assert.ok(merged.assets['music:track:t_new']);
});
