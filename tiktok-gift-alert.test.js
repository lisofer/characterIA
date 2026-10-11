'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createGiftTracker}=require('./tiktok-chat-runtime');
function gift(id,at=1000,count=1,pending=false){
 return {kind:'gift',id,at,count,pending,username:'juanma',name:'Juanma',giftId:'5655',giftName:'Rosa',emoji:'🌹'};
}
function snapshot(events=[],extra={}){
 return {username:'peleasfalopa',roomId:'12345',connectedAt:500,events,...extra};
}
test('Detecta una rosa al instante y emite una sola señal para el futuro agradecimiento',()=>{
 let now=1000;
 const tracker=createGiftTracker(()=>now);
 assert.deepEqual(tracker.consume(snapshot(),false),{changes:[],completed:[]});
 const first=tracker.consume(snapshot([gift(1)]));
 assert.equal(first.changes.length,1);
 assert.equal(first.completed.length,1);
 assert.equal(first.completed[0].name,'Juanma');
 assert.equal(first.completed[0].giftName,'Rosa');
 assert.equal(first.completed[0].count,1);
 const again=tracker.consume(snapshot([gift(1)]));
 assert.equal(again.changes.length,0);
 assert.equal(again.completed.length,0);
});
test('Una racha de rosas se ve desde el principio pero se agradece una sola vez al terminar',()=>{
 let now=1000;
 const tracker=createGiftTracker(()=>now);
 tracker.consume(snapshot(),false);
 const first=tracker.consume(snapshot([gift(10,1000,1,true)]));
 assert.equal(first.changes.length,1);
 assert.equal(first.completed.length,0);
 now=2000;
 const middle=tracker.consume(snapshot([gift(10,2000,4,true)]));
 assert.equal(middle.changes[0].count,4);
 assert.equal(middle.completed.length,0);
 now=2800;
 const final=tracker.consume(snapshot([gift(10,2800,6,false)]));
 assert.equal(final.changes[0].count,6);
 assert.equal(final.completed.length,1);
 assert.equal(final.completed[0].count,6);
 assert.equal(tracker.consume(snapshot([gift(10,2800,6,false)])).completed.length,0);
});
test('Si TikTok omite el final de una racha, se consolida tras unos segundos',()=>{
 let now=2000;
 const tracker=createGiftTracker(()=>now);
 tracker.consume(snapshot(),false);
 tracker.consume(snapshot([gift(7,2000,3,true)]));
 now=7900;
 assert.equal(tracker.consume(snapshot([gift(7,2000,3,true)])).completed.length,0);
 now=8200;
 const fallback=tracker.consume(snapshot([gift(7,2000,3,true)]));
 assert.equal(fallback.completed.length,1);
 assert.equal(fallback.completed[0].count,3);
 assert.equal(tracker.consume(snapshot([gift(7,8200,3,false)])).completed.length,0);
});
test('Al abrir el panel no dispara agradecimientos por regalos anteriores',()=>{
 const tracker=createGiftTracker(()=>10000);
 const old=tracker.consume(snapshot([gift(15,4000,1,false)]),false);
 assert.equal(old.changes.length,0);
 assert.equal(old.completed.length,0);
 const later=tracker.consume(snapshot([gift(15,4000,1,false),gift(16,10000,1,false)]),false);
 assert.deepEqual(later.completed.map(x=>x.id),[16]);
});
test('Al cambiar de cuenta o reconectar inicia una nueva sesión sin mezclar regalos',()=>{
 const tracker=createGiftTracker(()=>2000);
 tracker.consume(snapshot(),false);
 assert.deepEqual(tracker.consume(snapshot([gift(1,2000)])).completed.map(x=>x.id),[1]);
 assert.equal(tracker.consume(snapshot([gift(1,2000)])).completed.length,0);
 const next=snapshot([gift(2,2000)],{username:'otro_live',roomId:'987',connectedAt:1500});
 assert.equal(tracker.consume(next,true).completed.length,1);
 assert.equal(tracker.consume(next,true).completed.length,0);
});
test('Diferencia una actualización visual de la señal final para no repetir agradecimientos',()=>{
 let now=1000;
 const tracker=createGiftTracker(()=>now);
 tracker.consume(snapshot(),false);
 const a=tracker.consume(snapshot([gift(50,1000,1,true)]));
 const b=tracker.consume(snapshot([gift(50,1000,1,true)]));
 now=1400;
 const c=tracker.consume(snapshot([gift(50,1400,2,false)]));
 assert.deepEqual([a.changes.length,b.changes.length,c.changes.length],[1,0,1]);
 assert.deepEqual([a.completed.length,b.completed.length,c.completed.length],[0,0,1]);
});

test('El panel muestra una alerta de regalo y emite el evento sin duplicarlo al actualizarse',async()=>{
 const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
 const source=fs.readFileSync(path.join(__dirname,'tiktok-chat-runtime.js'),'utf8');
 class Element{
  constructor(id){
   this.id=id;this.value='';this.children=[];this.hidden=id==='ttChatGiftAlert';
   this.dataset={};this.style={};this.scrollHeight=0;this.scrollTop=0;this.clientHeight=100;
   this.textContent='';this.disabled=false;
  }
  addEventListener(){}
  setAttribute(key,val){this[key]=val}
  replaceChildren(...children){this.children=children}
  append(...children){this.children.push(...children)}
  focus(){}
 }
 const ids=['ttChatPanel','ttChatStatus','ttChatConnect','ttChatRetry','ttChatSettings','ttChatUser',
  'ttChatUserRow','ttChatDiagnostics','ttChatMessages','ttChatError','ttChatGiftAlert','ttChatTestGift','ttChatGiftDebug'];
 const elements=Object.fromEntries(ids.map(id=>[id,new Element(id)]));
 const document={readyState:'complete',activeElement:null,hidden:false,
  getElementById:id=>elements[id],createElement:tag=>new Element(tag)};
 const now=Date.now();
 let state={status:'connected',username:'peleasfalopa',roomId:'123',connectedAt:now,
  comments:[],events:[],giftEvents:0,chatEvents:0,wsFrames:2,decodedEvents:2};
 const published=[];
 const window={addEventListener(){},dispatchEvent:e=>published.push(e)};
 class CustomEvent{constructor(type,opts){this.type=type;this.detail=opts.detail}}
 const env={window,document,CustomEvent,fetch:async()=>({ok:true,json:async()=>state}),
  localStorage:{getItem:()=>null,setItem(){}},
  setInterval:()=>{},setTimeout:()=>1,clearTimeout:()=>{},console,Date,Number,String,Map,Set,Boolean};
 vm.runInNewContext(source,env,{filename:'tiktok-chat-runtime.js'});
 async function flush(){for(let i=0;i<14;i++)await Promise.resolve()}
 await flush();
 assert.equal(elements.ttChatGiftAlert.hidden,true);
 const callbacks=[];
 const unsub=window.PERSONA_TIKTOK_CHAT.onGift(gift=>callbacks.push(gift));
 state={...state,giftEvents:1,events:[{kind:'gift',id:20,username:'juanma',name:'Juanma',
  giftId:'5655',giftName:'Rosa',count:1,pending:false,emoji:'🌹',at:Date.now()}]};
 window.PERSONA_TIKTOK_CHAT.refresh();await flush();
 assert.equal(elements.ttChatGiftAlert.hidden,false);
 assert.match(elements.ttChatGiftAlert.textContent,/Juanma envió Rosa/);
 assert.equal(callbacks.length,1);
 assert.equal(callbacks[0].username,'juanma');
 assert.equal(published[0].type,'persona:tiktok-gift');
 assert.equal(published[0].detail.giftName,'Rosa');
 assert.equal(window.PERSONA_TIKTOK_CHAT.lastGift().count,1);
 window.PERSONA_TIKTOK_CHAT.refresh();await flush();
 assert.equal(callbacks.length,1);
 assert.equal(published.length,1);
 unsub();
});

test('Prueba visual no genera evento de regalo que luego sea agradecido por la IA',async()=>{
 const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
 const src=fs.readFileSync(path.join(__dirname,'tiktok-chat-runtime.js'),'utf8');
 class E{
  constructor(id){this.id=id;this.value='';this.children=[];this.hidden=id==='ttChatGiftAlert';this.dataset={};this.style={};this.textContent='';this.scrollHeight=0;this.scrollTop=0;this.clientHeight=100;this.listeners={}}
  addEventListener(event,cb){this.listeners[event]=cb}
  setAttribute(name,value){this[name]=value}
  replaceChildren(...items){this.children=items}
  append(...items){this.children.push(...items)}
  focus(){}
 }
 const keys=['ttChatPanel','ttChatStatus','ttChatConnect','ttChatRetry','ttChatSettings','ttChatUser','ttChatUserRow','ttChatDiagnostics','ttChatMessages','ttChatError','ttChatGiftAlert','ttChatTestGift','ttChatGiftDebug'];
 const nodes=Object.fromEntries(keys.map(k=>[k,new E(k)]));
 const doc={readyState:'complete',activeElement:null,hidden:false,getElementById:k=>nodes[k],createElement:k=>new E(k)};
 const events=[],window={addEventListener(){},dispatchEvent:e=>events.push(e)};
 class CustomEvent{constructor(type,init){this.type=type;this.detail=init.detail}}
 const env={document:doc,window,CustomEvent,Date,Number,String,Boolean,Map,Set,
  fetch:async()=>({ok:true,json:async()=>({status:'connected',username:'peleasfalopa',roomId:'1',connectedAt:1,events:[],comments:[]})}),
  localStorage:{getItem:()=>null,setItem(){}},setTimeout:()=>1,clearTimeout(){},setInterval(){},console};
 vm.runInNewContext(src,env,{filename:'tiktok-chat-runtime.js'});
 const callbacks=[];
 window.PERSONA_TIKTOK_CHAT.onGift(gift=>callbacks.push(gift));
 nodes.ttChatTestGift.listeners.click();
 assert.equal(nodes.ttChatGiftAlert.hidden,false);
 assert.match(nodes.ttChatGiftAlert.textContent,/Juanma envió Rosa/);
 assert.equal(callbacks.length,0);
 assert.equal(events.length,0);
 assert.match(nodes.ttChatGiftDebug.textContent,/Prueba visual/);
});
