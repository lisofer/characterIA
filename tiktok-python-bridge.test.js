'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createPythonGiftBridge}=require('./tiktok-python-bridge');
const {createTikTokChat}=require('./tiktok-chat');
function stub(){
 const children=[];
 function spawn(cmd,args,opts){
  const proc=new EventEmitter();
  proc.stdout=new EventEmitter();proc.stderr=new EventEmitter();
  proc.killed=false;proc.kill=()=>{proc.killed=true};
  proc.cmd=cmd;proc.args=args;proc.options=opts;
  children.push(proc);
  return proc;
 }
 return {spawn,children};
}
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve()};
test('Inicia Python solo cuando se conecta una cuenta y reconoce un regalo por NDJSON',()=>{
 const {spawn,children}=stub();
 const gifts=[];
 const bridge=createPythonGiftBridge({spawn,python:'/opt/persona-python/bin/python',
  script:'/app/tiktok-python-worker.py',onGift:g=>gifts.push(g)});
 assert.equal(children.length,0);
 bridge.start('peleasfalopa');
 assert.equal(children.length,1);
 assert.deepEqual(children[0].args,['-u','/app/tiktok-python-worker.py','@peleasfalopa']);
 children[0].stdout.emit('data','{"type":"connected","roomId":"123"}\n');
 assert.equal(bridge.snapshot().status,'connected');
 children[0].stdout.emit('data','{"type":"gift","giftName":"Rosa","giftId":"5655","count":3,');
 children[0].stdout.emit('data','"user":{"username":"juanma","name":"Juanma"}}\n');
 assert.equal(bridge.snapshot().gifts,1);
 assert.equal(gifts.length,1);
 assert.equal(gifts[0].user.displayId,'juanma');
 assert.equal(gifts[0].giftName,'Rosa');
 assert.equal(gifts[0].repeatCount,3);
});
test('El proceso se cierra al desconectar y se ignoran eventos atrasados',()=>{
 const {spawn,children}=stub(),gifts=[];
 const bridge=createPythonGiftBridge({spawn,onGift:g=>gifts.push(g)});
 bridge.start('peleasfalopa');
 bridge.stop();
 assert.equal(children[0].killed,true);
 assert.equal(bridge.snapshot().status,'idle');
 children[0].stdout.emit('data','{"type":"gift","user":{"username":"x"},"giftId":"5655"}\n');
 assert.equal(gifts.length,0);
});
test('Los fallos de Python se muestran sin interrumpir el lector de Node',()=>{
 const {spawn,children}=stub();
 const bridge=createPythonGiftBridge({spawn});
 bridge.start('cuenta_live');
 children[0].stdout.emit('data','{"type":"error","message":"Euler free limit"}\n');
 assert.equal(bridge.snapshot().status,'error');
 assert.match(bridge.snapshot().error,/Euler/);
});
test('Una lectura de regalos no debe ejecutar comandos ni aceptar un @usuario inválido',()=>{
 const {spawn,children}=stub();
 const bridge=createPythonGiftBridge({spawn});
 bridge.start('usuario; rm -rf /');
 assert.equal(children.length,0);
 assert.equal(bridge.snapshot().status,'error');
 bridge.start('@cuenta.valida');
 assert.equal(children.length,1);
 assert.equal(children[0].args[2],'@cuenta.valida');
 assert.equal(children[0].options.stdio[0],'ignore');
});
test('El puente Python agrega regalos al mismo historial de Persona Studio',async()=>{
 const {spawn,children}=stub(),bridge=createPythonGiftBridge({spawn});
 class FakeConnector extends EventEmitter{
  async connect(){this.emit('connected',{roomId:'1'});return {roomId:'1'}}
  disconnect(){}
 }
 const t=createTikTokChat({makePythonGiftBridge:opts=>createPythonGiftBridge({...opts,spawn}),
  loadConnector:async()=>({TikTokLiveConnection:FakeConnector,WebcastEvent:{CHAT:'chat',GIFT:'gift'}})});
 t.start('peleasfalopa');await tick();
 children[0].stdout.emit('data','{"type":"connected","roomId":"1"}\n');
 children[0].stdout.emit('data','{"type":"gift","giftId":"5655","giftName":"Rosa","count":1,"user":{"username":"juanma","name":"Juanma"}}\n');
 const state=t.snapshot();
 assert.equal(state.python.status,'connected');
 assert.equal(state.python.gifts,1);
 assert.equal(state.pythonGiftEvents,1);
 assert.equal(state.giftEvents,1);
 assert.equal(state.events.at(-1).kind,'gift');
 assert.equal(state.events.at(-1).username,'juanma');
 t.stop();
 assert.equal(children[0].killed,true);
});
test('Un regalo también se procesa si Node falló pero Python logró conectarse',async()=>{
 const {spawn,children}=stub(),bridge=createPythonGiftBridge({spawn});
 class Failing extends EventEmitter{
  async connect(){throw Error('Euler Node limitado')}
  disconnect(){}
 }
 const t=createTikTokChat({makePythonGiftBridge:opts=>createPythonGiftBridge({...opts,spawn}),
  loadConnector:async()=>({TikTokLiveConnection:Failing,WebcastEvent:{GIFT:'gift'}})});
 t.start('peleasfalopa');await tick();
 assert.equal(t.snapshot().status,'error');
 children[0].stdout.emit('data','{"type":"connected","roomId":"1"}\n');
 children[0].stdout.emit('data','{"type":"gift","giftName":"Rose","giftId":"5655","count":1,"user":{"username":"juanma","name":"Juanma"}}\n');
 assert.equal(t.snapshot().events.at(-1).kind,'gift');
 assert.equal(t.snapshot().python.status,'connected');
});
test('No duplica un mismo regalo si lo recibieron los lectores Node y Python',async()=>{
 const {spawn,children}=stub(),bridge=createPythonGiftBridge({spawn});
 let node;
 class Fake extends EventEmitter{
  constructor(){super();node=this}
  async connect(){return {roomId:'1'}}
  disconnect(){}
 }
 const t=createTikTokChat({makePythonGiftBridge:opts=>createPythonGiftBridge({...opts,spawn}),
  loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{GIFT:'gift'}})});
 t.start('peleasfalopa');await tick();
 node.emit('gift',{giftId:5655,giftName:'Rose',repeatCount:1,user:{displayId:'juanma'}});
 children[0].stdout.emit('data','{"type":"connected","roomId":"1"}\n');
 children[0].stdout.emit('data','{"type":"gift","giftId":"5655","giftName":"Rosa","count":1,"user":{"username":"juanma","name":"Juanma"}}\n');
 assert.equal(t.snapshot().events.length,1);
 assert.equal(t.snapshot().pythonGiftEvents,1);
});
