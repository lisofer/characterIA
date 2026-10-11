'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {normalizeUsername,normalizeComment,createTikTokChat}=require('./tiktok-chat');
const tick=async()=>{for(let i=0;i<10;i++)await Promise.resolve()};
test('Valida el @usuario y filtra datos del comentario',()=>{
 assert.equal(normalizeUsername('@peleasfalopa'),'peleasfalopa');
 assert.equal(normalizeUsername('https://tiktok.com/@algo/live'),null);
 assert.equal(normalizeUsername('hola espacio'),null);
 assert.deepEqual(normalizeComment({user:{uniqueId:'usuario',nickname:'Alias'},comment:' Hola '},7,123),{id:7,username:'usuario',name:'Alias',text:'Hola',at:123});
});
test('Conexión, comentarios en tiempo real y desconexión manual',async()=>{
 class FakeConnection extends EventEmitter{
  async connect(){this.emit('connected',{roomId:'123'});return {roomId:'123'}}
  disconnect(){this.emit('disconnected')}
 }
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:FakeConnection,WebcastEvent:{CHAT:'chat'}})});
 const s=c.start('@peleasfalopa');
 assert.equal(s.status,'connecting');
 await tick();
 assert.equal(c.snapshot().status,'connected');
 assert.equal(c.snapshot().roomId,'123');
 assert.equal(c.snapshot().comments.length,0);
 // Se prueba el evento a través de la instancia que usa el puente.
});
test('No se abre una conexión antigua después de desconectar durante la carga',async()=>{
 let release;
 const loader=new Promise(resolve=>release=resolve);
 const c=createTikTokChat({loadConnector:()=>loader});
 c.start('peleasfalopa');
 c.stop();
 release({TikTokLiveConnection:class Fake extends EventEmitter{}});
 await tick();
 assert.equal(c.snapshot().status,'idle');
});
test('El historial se limita a 75 comentarios y se limpia al desconectar',async()=>{
 let conn;
 class Fake extends EventEmitter{
  constructor(){super();conn=this}
  async connect(){return {roomId:'1'}}
  disconnect(){}
 }
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat'}})});
 c.start('peleasfalopa');await tick();
 for(let i=0;i<120;i++)conn.emit('chat',{comment:'Hola '+i,uniqueId:'viewer'});
 assert.equal(c.snapshot().comments.length,75);
 assert.equal(c.snapshot().comments[0].text,'Hola 45');
 const last=c.snapshot().comments.at(-1);
 assert.equal(last.text,'Hola 119');
 c.stop();
 assert.equal(c.snapshot().comments.length,0);
 assert.equal(c.snapshot().status,'idle');
});
test('Un LIVE desconectado se muestra con estado claro',async()=>{
 let conn;
 class Fake extends EventEmitter{
  constructor(){super();conn=this}
  async connect(){return {roomId:'2'}}
  disconnect(){}
 }
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat'}})});
 c.start('peleasfalopa');await tick();
 conn.emit('disconnected');
 assert.equal(c.snapshot().status,'disconnected');
 assert.match(c.snapshot().error,/Reconectar/);
});
