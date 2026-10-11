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

test('Cambiar a otro LIVE reemplaza la cuenta conectada en lugar de desconectar sin conectar',async()=>{
 const instances=[];
 class Fake extends EventEmitter{
  constructor(username){super();this.username=username;this.closed=false;instances.push(this)}
  async connect(){this.emit('connected',{roomId:this.username+'_room'});return {roomId:this.username+'_room'}}
  disconnect(){this.closed=true}
 }
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat'}})});
 c.start('primer_live');await tick();
 assert.equal(c.snapshot().username,'primer_live');
 c.start('segundo_live');await tick();
 assert.equal(c.snapshot().username,'segundo_live');
 assert.equal(c.snapshot().roomId,'segundo_live_room');
 assert.ok(instances[0].closed);
 instances[0].emit('chat',{comment:'ANTIGUO',user:{uniqueId:'usuario1'}});
 instances[1].emit('chat',{comment:'NUEVO',user:{uniqueId:'usuario2'}});
 assert.deepEqual(c.snapshot().comments.map(c=>c.text),['NUEVO']);
});
test('El botón reconectar crea conexión nueva aunque el @usuario sea el mismo',async()=>{
 let count=0;
 class Fake extends EventEmitter{
  constructor(){super();count++}
  async connect(){return {roomId:'sala'+count}}
  disconnect(){}
 }
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat'}})});
 c.start('peleasfalopa');await tick();
 assert.equal(count,1);
 c.start('peleasfalopa',{force:true});await tick();
 assert.equal(count,2);
 assert.equal(c.snapshot().roomId,'sala2');
});
test('Detecta conexión sin flujo de eventos y deja de mostrar Esperando indefinidamente',async()=>{
 let current=100000;
 class Fake extends EventEmitter{
  async connect(){this.emit('connected',{roomId:'999'});return {roomId:'999'}}
  disconnect(){}
 }
 const c=createTikTokChat({now:()=>current,loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat'}})});
 c.start('live_test');await tick();
 assert.equal(c.snapshot().warning,'');
 current+=15000;
 assert.match(c.snapshot().warning,/no está enviando datos/);
 assert.equal(c.snapshot().roomId,'999');
});
test('El flujo WebSocket y los paquetes decodificados permiten diagnosticar falta de chats',async()=>{
 let conn,current=100000;
 class Fake extends EventEmitter{
  constructor(){super();conn=this}
  async connect(){this.emit('connected',{roomId:'abc'});return {roomId:'abc'}}
  disconnect(){}
 }
 const c=createTikTokChat({now:()=>current,loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat'}})});
 c.start('live_test');await tick();
 conn.emit('websocketConnected');
 conn.emit('websocketData',new Uint8Array([42]));
 conn.emit('decodedData','WebcastMemberMessage',{});
 current+=15000;
 assert.equal(c.snapshot().socketConnected,true);
 assert.equal(c.snapshot().wsFrames,1);
 assert.equal(c.snapshot().decodedEvents,1);
 assert.match(c.snapshot().warning,/aún no llegaron comentarios/);
});
test('Recupera comentarios WebcastChatMessage desde decodedData y evita duplicados con el evento chat',async()=>{
 let conn;
 class Fake extends EventEmitter{
  constructor(){super();conn=this}
  async connect(){return {roomId:'123'}}
  disconnect(){}
 }
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat'}})});
 c.start('live_test');await tick();
 const msg={comment:'hola gente',common:{msgId:'123'},user:{uniqueId:'paco',nickname:'Paco'}};
 conn.emit('decodedData','WebcastChatMessage',msg);
 conn.emit('chat',msg);
 assert.equal(c.snapshot().comments.length,1);
 assert.equal(c.snapshot().comments[0].text,'hola gente');
 assert.equal(c.snapshot().comments[0].username,'paco');
 assert.equal(c.snapshot().chatEvents,1);
});
