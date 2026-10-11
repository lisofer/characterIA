'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');

function between(from,to){
 const a=html.indexOf(from),b=html.indexOf(to,a);
 assert.ok(a>=0&&b>a,'No se encontró '+from);
 return html.slice(a,b);
}
function sse(part){
 return 'data: '+JSON.stringify({candidates:[{content:{parts:[{text:part}]}}]})+'\n\n';
}

test('Gemini entrega la primera frase por streaming antes de completar la tanda',async()=>{
 const source=between('async function duelRequest(model,payload,external=null,onPartial=null){','function duelParseBatch(');
 const first=sse('{"lines":["Primera frase",'),last=sse('"Segunda frase"]}');
 const bytes=new TextEncoder().encode(first);
 const chunks=[bytes.slice(0,bytes.length-6),bytes.slice(bytes.length-6),new TextEncoder().encode(last)];
 let openSecond;
 const gate=new Promise(resolve=>{openSecond=resolve});
 let offset=0;
 const fetch=async()=>({ok:true,body:{getReader(){return{async read(){
  if(offset===2)await gate;
  if(offset>=chunks.length)return{done:true};
  return{done:false,value:chunks[offset++]};
 }}}}});
 const request=new Function('fetch','D','parseSSE','TextDecoder',source+'\nreturn duelRequest;')(
  fetch,{},()=>'',TextDecoder);
 const partials=[];
 const current=request('gemini-test',{},new AbortController(),text=>partials.push(text));
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok(partials.some(value=>value.includes('Primera frase')),'La primera frase no llegó anticipadamente');
 assert.ok(partials.every(value=>!value.includes('Segunda frase')),'Se esperó por toda la tanda');
 openSecond();
 assert.equal(await current,'{"lines":["Primera frase","Segunda frase"]}');
});

test('La primera frase comienza su TTS sin esperar el JSON final de Gemini',async()=>{
 const code=between('function createEarlyDuelBatch(t,participants,bounds){','function assignEarlyDuelAudio(j,entry){');
 const D={contextSerial:0,running:true,autoContinueRequested:true,generatingBatch:false,stopAfterCurrent:false,
  speech:{ready:true,side:'left'},nextPrepared:null};
 let finish;
 const warming=[];
 const make=new Function('D','duelGenerateBatch','warmFirstDuelVoice','duelCount',
  'duelLimitBounds','cancelEarlyDuelBatch',code+'\nreturn {createEarlyDuelBatch,prepareNextDuelBatch,useEarlyDuelBatch};')(
  D,(_t,_p,_min,_max,_ctrl,onPartial)=>{
   onPartial('{"lines":["Hola desde el vivo",');
   return new Promise(resolve=>{finish=resolve});
  },
  (_job,entry)=>warming.push(entry),
  t=>t.messages.filter(m=>m.side==='left'||m.side==='right').length,
  ()=>({min:1,max:12}),job=>{if(job){job.cancelled=true;job.controller.abort()}});
 const topic={id:'tema',messages:[],pending:[],left:'a',right:'b'};
 const job=make.createEarlyDuelBatch(topic,{left:'a',right:'b'},{min:1,max:12});
 assert.equal(warming.length,1,'No se precalentó Fish con la primera frase');
 assert.equal(warming[0].text,'Hola desde el vivo');
 finish(['Hola desde el vivo','Otra respuesta']);
 const lines=await job.promise;
 assert.equal(lines.length,2);
 assert.equal(warming.length,1,'No duplicar solicitudes Fish para la primera frase');
});

test('Susurrar vacío puede anticipar la siguiente tanda mientras hablan',async()=>{
 const code=between('function createEarlyDuelBatch(t,participants,bounds){','function assignEarlyDuelAudio(j,entry){');
 const D={contextSerial:0,running:true,autoContinueRequested:true,generatingBatch:false,stopAfterCurrent:false,
  speech:{ready:true,side:'left'},nextPrepared:null};
 const calls=[];
 const run=new Function('D','duelGenerateBatch','warmFirstDuelVoice','duelCount',
  'duelLimitBounds','cancelEarlyDuelBatch',code+'\nreturn {prepareNextDuelBatch,useEarlyDuelBatch};')(
  D,(t)=>{calls.push(t.messages.map(m=>m.text));return Promise.resolve(['A continuación'])},
  ()=>{},t=>t.messages.filter(m=>m.side==='left'||m.side==='right').length,
  ()=>({min:1,max:12}),job=>{if(job){job.cancelled=true;job.controller.abort()}});
 const m1={id:'1',side:'left',text:'Primero'},m2={id:'2',side:'right',text:'Segundo'};
 const t={id:'debate',left:'a',right:'b',messages:[m1,m2],pending:[m1,m2]};
 run.prepareNextDuelBatch(t,false);
 assert.equal(calls.length,1,'El click debía iniciar Gemini antes de terminar el audio actual');
 assert.deepEqual(calls[0],['Primero','Segundo']);
 const reused=run.useEarlyDuelBatch(t,{left:'a',right:'b'});
 assert.ok(reused,'La nueva tanda no reutilizó el trabajo anticipado');
 assert.equal((await reused.promise).length,1);
});

test('Una interrupción del moderador no incluye intervenciones futuras aún no dichas',()=>{
 const code=between('function createEarlyDuelBatch(t,participants,bounds){','function assignEarlyDuelAudio(j,entry){');
 const D={contextSerial:2,running:true,generatingBatch:false,stopAfterCurrent:false,
  speech:{ready:true,side:'left'},nextPrepared:null};
 let captured;
 const run=new Function('D','duelGenerateBatch','warmFirstDuelVoice','duelCount',
  'duelLimitBounds','cancelEarlyDuelBatch',code+'\nreturn {prepareNextDuelBatch};')(
  D,t=>{captured=t.messages.map(x=>x.text);return Promise.resolve(['Nueva réplica'])},
  ()=>{},t=>t.messages.filter(m=>m.side==='left'||m.side==='right').length,
  ()=>({min:1,max:12}),job=>{if(job){job.cancelled=true;job.controller.abort()}});
 const current={id:'a',side:'left',text:'Estoy hablando'};
 const future={id:'b',side:'right',text:'Respuesta vieja no dicha'};
 const moderator={id:'c',side:'human',text:'Pregunta del moderador'};
 const t={id:'t',left:'a',right:'b',messages:[current,future,moderator],pending:[current,future]};
 run.prepareNextDuelBatch(t,true);
 assert.deepEqual(captured,['Estoy hablando','Pregunta del moderador']);
});

test('Orquestación: se inicia Gemini antes de esperar la voz del moderador y se reutiliza Fish',()=>{
 const code=between('async function runDuelBatch(skipModeratorDraft=false){','// La apertura de pregunta o exclamación');
 assert.ok(code.indexOf('createEarlyDuelBatch(')<code.indexOf('await drainModeratorQueue(t,token)'));
 assert.ok(code.includes('assignEarlyDuelAudio(prepared,entries[0])'));
 assert.ok(code.includes('await Promise.all(['),'Las muestras se cargan en paralelo');
 assert.ok(html.includes('prewarmModeratorIntervention(entry);'));
 assert.ok(html.includes('if(!D.audioJobs.has(entry.id))D.audioJobs.set('));
});
