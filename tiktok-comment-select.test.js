'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
const runtime=fs.readFileSync(path.join(__dirname,'tiktok-chat-runtime.js'),'utf8');
const {commentSpeaker,commentToModerator}=require('./tiktok-chat-runtime');

test('El comentario menciona @usuario real y, si falta, utiliza el nombre de TikTok',()=>{
 assert.equal(commentSpeaker({username:'juanma_15',name:'Juanma',hasHandle:true}),'@juanma_15');
 assert.equal(commentToModerator({username:'juanma_15',name:'Juanma',hasHandle:true,text:'Saludos de México'}),
  '@juanma_15 dice: «Saludos de México»');
 assert.equal(commentToModerator({username:'María López',name:'María López',hasHandle:false,text:'Hola a todos'}),
  'María López dice: «Hola a todos»');
 assert.equal(commentToModerator({username:'',name:'',hasHandle:false,text:'Hola'}),'Espectador dice: «Hola»');
 assert.equal(commentToModerator({username:'',name:'',hasHandle:false,text:'   '}),'');
});

function moderatorFixture(){
 const start=html.indexOf('function newModeratorEntry(t,text,whisper=false){');
 const end=html.indexOf('async function prepareModeratorAudio(',start);
 assert.ok(start>=0&&end>start,'No se encontró el sistema de moderador');
 const listeners=new Map(),window={addEventListener:(type,fn)=>listeners.set(type,fn)};
 const t={messages:[],pending:[]},D={running:false,generatingBatch:false,stopAfterCurrent:false,
  moderatorQueue:[],autoContinueRequested:false};
 const elements={duelHuman:{value:'Borrador del moderador'},duelModeratorVoice:{value:'voz_1'},
  duelModeratorSend:{},duelModeratorWhisper:{}};
 const calls={batch:[],toast:[],append:[],saves:0};
 new Function('window','D','duelActive','$','profileIndex','saveDuel','appendDuelMessage',
  'runDuelBatch','toast','setDuelStopButtons',html.slice(start,end))(
  window,D,()=>t,id=>elements[id],()=>[{id:'voz_1'}],
  ()=>calls.saves++,entry=>calls.append.push(entry),opt=>calls.batch.push(opt),
  (...x)=>calls.toast.push(x),()=>{});
 return {listeners,t,D,calls,elements};
}

test('El clic entra como intervención hablada del moderador y deja el borrador intacto',()=>{
 const f=moderatorFixture();
 const event={detail:{message:'@juanma dice: «Saludos de México»',accepted:false}};
 const handler=f.listeners.get('persona:tiktok-comment-selected');
 assert.equal(typeof handler,'function');
 handler(event);
 assert.equal(event.detail.accepted,true);
 assert.equal(f.t.messages.length,1);
 assert.equal(f.D.moderatorQueue.length,1);
 assert.equal(f.t.messages[0].kind,'spoken');
 assert.equal(f.t.messages[0].side,'human');
 assert.equal(f.t.messages[0].text,'@juanma dice: «Saludos de México»');
 assert.equal(f.elements.duelHuman.value,'Borrador del moderador');
 assert.deepEqual(f.calls.batch,[true]); // no leer el textarea al iniciar por comentario
 assert.equal(f.calls.saves,1);
});

test('El comentario seleccionado durante una tanda obliga a los personajes a reaccionar',()=>{
 const f=moderatorFixture();
 f.D.running=true;
 f.D.generatingBatch=true;
 f.t.pending=[{id:'futura',side:'left',text:'Línea antigua'}];
 let aborts=0;
 f.D.abort={abort:()=>aborts++};
 f.listeners.get('persona:tiktok-comment-selected')({detail:{message:'@sofi dice: «¿Qué opinan?»'}});
 assert.equal(f.t.needsReplan,true);
 assert.equal(f.D.restartForModerator,true);
 assert.equal(f.D.autoContinueRequested,true);
 assert.equal(aborts,1);
 assert.equal(f.D.moderatorQueue.length,1);
});

test('Si no hay voz seleccionada, el clic no se considera enviado ni agrega intervención',()=>{
 const f=moderatorFixture();
 f.elements.duelModeratorVoice.value='inexistente';
 const event={detail:{message:'@juanma dice: «Hola»'}};
 f.listeners.get('persona:tiktok-comment-selected')(event);
 assert.equal(event.detail.accepted,false);
 assert.match(event.detail.error,/Elegí la voz/);
 assert.equal(f.t.messages.length,0);
});

function webFixture(initial){
 class Element{
  constructor(tag){this.tag=tag;this.id=tag;this.value='';this.dataset={};this.children=[];
   this.listeners={};this.hidden=tag==='ttChatGiftAlert';this.textContent='';
   this.scrollHeight=0;this.scrollTop=0;this.clientHeight=100;this.disabled=false;
  }
  addEventListener(type,fn){this.listeners[type]=fn}
  setAttribute(key,val){this[key]=val}
  replaceChildren(...items){this.children=items}
  append(...items){this.children.push(...items)}
  focus(){}
 }
 const ids=['ttChatPanel','ttChatStatus','ttChatConnect','ttChatRetry','ttChatSettings','ttChatUser',
  'ttChatUserRow','ttChatMessages','ttChatError','ttChatGiftAlert'];
 const elements=Object.fromEntries(ids.map(id=>[id,new Element(id)]));
 const events=[];
 let state=initial;
 const window={addEventListener(){},dispatchEvent:e=>{events.push(e);e.detail.accepted=true}};
 const document={readyState:'complete',activeElement:null,hidden:false,
  getElementById:key=>elements[key],createElement:tag=>new Element(tag)};
 class CustomEvent{constructor(type,params){this.type=type;this.detail=params.detail}}
 const env={document,window,CustomEvent,Date,Number,String,Boolean,Map,Set,
  fetch:async()=>({ok:true,json:async()=>state}),
  localStorage:{getItem:()=>null,setItem(){}},
  setTimeout:()=>1,clearTimeout(){},setInterval(){},console};
 vm.runInNewContext(runtime,env,{filename:'tiktok-chat-runtime.js'});
 return {elements,events,window,setState:value=>{state=value},async refresh(){
  window.PERSONA_TIKTOK_CHAT.refresh();for(let i=0;i<16;i++)await Promise.resolve()
 }};
}

test('Comentarios son botones accesibles; solo un clic los envía y quedan marcados',async()=>{
 const state={username:'peleasfalopa',status:'connected',roomId:'sala',connectedAt:99,comments:[],events:[
  {kind:'comment',id:1,name:'Juanma',username:'juanma',hasHandle:true,text:'Saludos de México',at:Date.now()},
  {kind:'gift',id:2,name:'Sofi',username:'sofi',giftName:'Rosa',count:1,at:Date.now()}
 ]};
 const f=webFixture(state);
 await f.refresh();
 assert.equal(f.events.length,0,'No debe leer ningún comentario automáticamente');
 const lines=f.elements.ttChatMessages.children;
 assert.equal(lines.length,2);
 assert.equal(lines[0].tag,'button');
 assert.equal(lines[0].type,'button');
 assert.equal(lines[1].tag,'div','Regalos no se transforman en botones');
 assert.match(lines[0].title,/Enviar este comentario/);
 lines[0].listeners.click();
 assert.equal(f.events.length,1);
 assert.equal(f.events[0].type,'persona:tiktok-comment-selected');
 assert.equal(f.events[0].detail.message,'@juanma dice: «Saludos de México»');
 assert.equal(lines[0].dataset.sent,'true');
 assert.equal(lines[0].children.at(-1).textContent,'✓ enviado al moderador');
 lines[0].listeners.click();
 assert.equal(f.events.length,1,'El doble clic no manda dos veces el comentario');
 f.setState({...state,events:[...state.events,{kind:'comment',id:3,username:'mari',hasHandle:true,text:'Hola',at:Date.now()}]});
 await f.refresh();
 assert.equal(f.elements.ttChatMessages.children[0].dataset.sent,'true',
  'La marca se mantiene cuando llegan otros mensajes');
});

test('Con un apodo sin @, el evento enviado conserva el nombre real',async()=>{
 const state={username:'peleasfalopa',status:'connected',roomId:'room',connectedAt:1,events:[
  {kind:'comment',id:1,username:'Una persona',name:'Una persona',hasHandle:false,text:'Hola, desde México',at:Date.now()}
 ]};
 const f=webFixture(state);await f.refresh();
 f.elements.ttChatMessages.children[0].listeners.click();
 assert.equal(f.events[0].detail.message,'Una persona dice: «Hola, desde México»');
});
