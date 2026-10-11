'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
function slice(start,end){
 const a=html.indexOf(start),b=html.indexOf(end,a+start.length);
 assert.ok(a>=0&&b>a,'Sección faltante: '+start);
 return html.slice(a,b);
}
const evaluate=new Function('D','duelMessageLabel','renderDuelTranscript','saveDuel','$','fetch','parseSSE','DUEL_MODEL',
 slice('function duelCount(topic){','function duelStatus(message){')+
 slice('const DUEL_MEMORY_STEP=60','async function duelSample(id){')+
 ';return {duelCount,duelMemoryMigrate,duelCompletedPublic,duelSummaryAvailable,duelSummaryWindow,duelCompactMemory,queueDuelSummary};');
const turns=(n,start=0)=>Array.from({length:n},(_,i)=>({
 id:'msg_'+(start+i),side:i%2?'right':'left',profileId:'p',text:'Respuesta '+(start+i)
}));
function fixture(count=60,request=async()=>({ok:true,text:async()=>JSON.stringify({text:'Memoria actualizada'})})){
 const topic={id:'topic',title:'La historia',theme:'Un romance',left:'a',right:'b',
  messages:turns(count),summary:'',summaryPublicAt:0,compactedTurns:0,compactedPublicCount:0,memoryVersion:0};
 const D={topics:[topic],activeId:topic.id,moderatorQueue:[],running:true};
 const box={duelSummary:{textContent:''}};let calls=0;
 const f=evaluate(D,m=>m.side==='human'?'MODERADOR':m.side,()=>{},()=>{},id=>box[id],
  (...args)=>{calls++;return request(...args)},body=>JSON.parse(body).text,'gemini-3.5-flash-lite');
 return {topic,D,f,calls:()=>calls};
}
async function flush(){for(let i=0;i<8;i++)await Promise.resolve()}
test('El resumen comienza después de 60 intervenciones públicas completadas, sin cortar las voces',async()=>{
 const {topic,f,calls}=fixture(59);
 f.queueDuelSummary(topic);await flush();assert.equal(calls(),0);
 topic.messages.push(turns(1,59)[0]);
 f.queueDuelSummary(topic);await flush();
 assert.equal(calls(),1);
 assert.equal(topic.summary,'Memoria actualizada');
 assert.equal(topic.summaryPublicAt,60);
 assert.equal(topic.compactedPublicCount,44);
 assert.equal(topic.messages.length,16);
 assert.equal(f.duelCount(topic),60);
});
test('Los turnos aún no pronunciados y los susurros no entran en el resumen',()=>{
 const {topic,D,f}=fixture(60);
 topic.messages.push({id:'whisper',kind:'whisper',side:'human',text:'SECRETO PRIVADO'});
 topic.pending=[{id:'msg_59'}];
 assert.equal(f.duelSummaryAvailable(topic),59);
 assert.equal(f.duelSummaryWindow(topic).length,59);
 topic.pending=[];
 const window=f.duelSummaryWindow(topic);
 assert.equal(window.length,60);
 assert.ok(window.every(m=>m.kind!=='whisper'));
 D.moderatorQueue=[{id:'human_1'}];
 topic.messages.push({id:'human_1',side:'human',text:'Espera'});
 assert.equal(f.duelSummaryWindow(topic).length,60);
});
test('Conserva el orden de los personajes después de compactar el historial',async()=>{
 const {topic,f}=fixture(60);
 const before=f.duelCount(topic)%2;
 f.queueDuelSummary(topic);await flush();
 assert.equal(f.duelCount(topic)%2,before);
 topic.messages.push(turns(2,60)[0]);
 assert.equal(f.duelCount(topic),61);
});
test('Actualiza la misma memoria al llegar a 120 mensajes y mantiene el historial acotado',async()=>{
 const {topic,f,calls}=fixture(120);
 f.queueDuelSummary(topic);
 await flush();
 await flush();
 await flush();
 assert.equal(calls(),2);
 assert.equal(topic.summaryPublicAt,120);
 assert.equal(topic.messages.length,16);
 assert.equal(f.duelCount(topic),120);
});
test('Un resumen que llega tarde no restaura memoria después de reiniciar',async()=>{
 let release;
 const request=()=>new Promise(resolve=>{release=()=>resolve({ok:true,text:async()=>JSON.stringify({text:'Resumen VIEJO'})})});
 const {topic,f,calls}=fixture(60,request);
 f.queueDuelSummary(topic);
 assert.equal(calls(),1);
 topic.messages=[];topic.summary='';topic.summaryAt=0;topic.summaryPublicAt=0;
 topic.compactedTurns=0;topic.compactedPublicCount=0;topic.memoryVersion++;
 release();await flush();
 assert.equal(topic.summary,'');
 assert.equal(topic.messages.length,0);
 assert.equal(f.duelCount(topic),0);
});
test('Migra memorias existentes sin volver a resumir las primeras 30 intervenciones',()=>{
 const {topic,f}=fixture(70);
 delete topic.summaryPublicAt;topic.summaryAt=30;topic.summary='Resumen viejo';
 f.duelMemoryMigrate(topic);
 assert.equal(topic.summaryPublicAt,30);
 assert.equal(f.duelSummaryAvailable(topic),40);
});
test('El botón reiniciar tema borra solo conversación y memoria; el escenario permanece',()=>{
 assert.match(html,/id="duelReset"/);
 const code=slice("$('duelReset').onclick=()=>{",'/* Ventana de salida');
 for(const field of ['t.messages=[]','t.summary=','t.summaryPublicAt=0','t.compactedTurns=0','t.compactedPublicCount=0',
 't.memoryVersion=','refreshDuelDisplay()'])assert.ok(code.includes(field),field);
 for(const field of ['t.title=','t.theme=','t.left=','t.right=','t.stageBackgroundId='])assert.ok(!code.includes(field),field);
 assert.match(html,/DUEL_MEMORY_STEP=60/);
 assert.match(html,/MEMORIA DE TODA LA HISTORIA/);
});
