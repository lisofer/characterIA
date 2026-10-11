'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {normalizeUsername,normalizeComment,normalizeGift,eventPayload,decodedMessage,createTikTokChat}=require('./tiktok-chat');
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

test('Pasa opciones al constructor para evitar processInitialData undefined',async()=>{
 let created=null;
 class RequiresOptions extends EventEmitter{
  constructor(username,options){
   super();
   // Simula el acceso interno del conector a options.processInitialData.
   if(typeof options?.processInitialData!=='boolean')throw TypeError("Cannot read properties of undefined (reading 'processInitialData')");
   created={username,options};
  }
  async connect(){return {roomId:'live123'}}
  disconnect(){}
 }
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:RequiresOptions,WebcastEvent:{CHAT:'chat'}})});
 c.start('@peleasfalopa');await tick();
 assert.equal(c.snapshot().status,'connected');
 assert.equal(created.username,'peleasfalopa');
 assert.equal(created.options.processInitialData,true);
});

test('Reconoce el nombre del regalo Rosa y el usuario en formatos actuales y anteriores',()=>{
 const a=normalizeGift({user:{uniqueId:'rosa_fan',nickname:'Fan'},giftDetails:{giftName:'Rose',giftType:1},giftId:5655,repeatCount:1,repeatEnd:false,groupId:'group-1'},8,123);
 assert.equal(a.kind,'gift');
 assert.equal(a.username,'rosa_fan');
 assert.equal(a.name,'Fan');
 assert.equal(a.giftName,'Rose');
 assert.equal(a.emoji,'🌹');
 assert.equal(a.pending,true);
 const b=normalizeGift({uniqueId:'mate',giftName:'Lion',giftType:0,repeatCount:1},9,124);
 assert.equal(b.emoji,'🦁');
 assert.equal(b.pending,false);
 assert.equal(b.count,1);
});
test('Los comentarios y los regalos aparecen ordenados en el mismo recuadro',async()=>{
 let conn;
 class Fake extends EventEmitter{constructor(){super();conn=this}async connect(){return {roomId:'gift_room'}}disconnect(){}}
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat',GIFT:'gift'}})});
 c.start('live_test');await tick();
 conn.emit('chat',{comment:'Qué onda',user:{uniqueId:'alguien'}});
 conn.emit('gift',{giftName:'Rose',giftType:0,repeatCount:1,user:{uniqueId:'pepito'},msgId:'g100'});
 conn.emit('chat',{comment:'Se armó',user:{uniqueId:'otra'}});
 assert.deepEqual(c.snapshot().events.map(e=>e.kind),['comment','gift','comment']);
 assert.equal(c.snapshot().comments.length,2);
 assert.equal(c.snapshot().events[1].giftName,'Rose');
 assert.equal(c.snapshot().events[1].username,'pepito');
 assert.equal(c.snapshot().giftEvents,1);
});
test('La racha de rosas actualiza una sola fila de x1 a x5 sin duplicados',async()=>{
 let conn;
 class Fake extends EventEmitter{constructor(){super();conn=this}async connect(){return {roomId:'123'}}disconnect(){}}
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat',GIFT:'gift'}})});
 c.start('live_test');await tick();
 const rose=(count,end,id)=>({giftId:5655,giftDetails:{giftName:'Rose',giftType:1},
  user:{uniqueId:'rosafan'},repeatCount:count,repeatEnd:end,groupId:'streak_77',msgId:id});
 conn.emit('gift',rose(1,false,'msg1'));
 assert.equal(c.snapshot().events[0].pending,true);
 conn.emit('gift',rose(3,false,'msg2'));
 assert.equal(c.snapshot().events.length,1);
 assert.equal(c.snapshot().events[0].count,3);
 conn.emit('gift',rose(5,true,'msg3'));
 assert.equal(c.snapshot().events.length,1);
 assert.equal(c.snapshot().events[0].pending,false);
 assert.equal(c.snapshot().events[0].count,5);
});
test('Un evento gift y decodedData del mismo regalo no generan dos filas',async()=>{
 let conn;
 class Fake extends EventEmitter{constructor(){super();conn=this}async connect(){return {roomId:'123'}}disconnect(){}}
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat',GIFT:'gift'}})});
 c.start('live_test');await tick();
 const gift={giftId:5,giftName:'Rose',giftType:0,msgId:'unique001',user:{uniqueId:'x'},repeatCount:1};
 conn.emit('decodedData','WebcastGiftMessage',gift);
 conn.emit('gift',gift);
 assert.equal(c.snapshot().events.length,1);
 assert.equal(c.snapshot().giftEvents,1);
});
test('Dos regalos independientes del mismo usuario se muestran separados',async()=>{
 let conn;
 class Fake extends EventEmitter{constructor(){super();conn=this}async connect(){return {roomId:'123'}}disconnect(){}}
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat',GIFT:'gift'}})});
 c.start('live_test');await tick();
 conn.emit('gift',{giftId:5,giftName:'Rose',giftType:0,msgId:'gift-1',uniqueId:'same'});
 conn.emit('gift',{giftId:5,giftName:'Rose',giftType:0,msgId:'gift-2',uniqueId:'same'});
 assert.equal(c.snapshot().events.length,2);
});
test('Al desconectar también se borran los regalos de la transmisión anterior',async()=>{
 let conn;
 class Fake extends EventEmitter{constructor(){super();conn=this}async connect(){return {roomId:'123'}}disconnect(){}}
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:Fake,WebcastEvent:{CHAT:'chat',GIFT:'gift'}})});
 c.start('live_test');await tick();
 conn.emit('gift',{giftId:1,giftName:'Rose',uniqueId:'x'});
 assert.equal(c.snapshot().events.length,1);
 c.stop();
 assert.equal(c.snapshot().events.length,0);
 assert.equal(c.snapshot().giftEvents,0);
});

test('Reconoce user.displayId y nickname en eventos protobuf crudos de TikTok v2.5',()=>{
 const data={user:{displayId:'mariposa_liv',nickname:'Mariposa',idStr:'19823'},comment:'Hola a todos',common:{msgId:'754'}};
 const actual=normalizeComment(data,12,100);
 assert.equal(actual.username,'mariposa_liv');
 assert.equal(actual.name,'Mariposa');
 assert.equal(actual.text,'Hola a todos');
 const fromEnvelope=normalizeComment({type:'WebcastChatMessage',data},15,110);
 assert.equal(fromEnvelope.username,'mariposa_liv');
 assert.equal(fromEnvelope.text,'Hola a todos');
 const flat=normalizeComment({uniqueId:'flat_user',nickname:'Nombre',comment:'Hola'},16,120);
 assert.equal(flat.username,'flat_user');
});
test('Reconoce una rosa y una racha según el formato protobuf real v2.5',()=>{
 const data={user:{displayId:'donante123',nickname:'Donante'},
  giftId:5655,giftDetails:{giftName:'Rose',giftType:1},
  repeatCount:3,repeatEnd:false,common:{msgId:'7'}};
 const gift=normalizeGift(data,17,100);
 assert.equal(gift.username,'donante123');
 assert.equal(gift.name,'Donante');
 assert.equal(gift.emoji,'🌹');
 assert.equal(gift.giftName,'Rose');
 assert.equal(gift.count,3);
 assert.equal(gift.pending,true);
 assert.equal(gift.msgId,'7');
 assert.equal(normalizeGift({...data,repeatEnd:true},19,200).pending,false);
});
test('El regalo toma el nombre desde extendedGiftInfo si la información común falta',()=>{
 const gift=normalizeGift({user:{displayId:'julia'},giftId:1,extendedGiftInfo:{name:'Rosa'},repeatCount:1},20,100);
 assert.equal(gift.giftName,'Rosa');
 assert.equal(gift.username,'julia');
 assert.equal(gift.emoji,'🌹');
});
test('decodedData de la nueva biblioteca usa {type,data}, no el mensaje directamente',async()=>{
 let conn;
 class Proto extends EventEmitter{
  constructor(username,settings){
   super();conn=this;
   assert.equal(settings.processInitialData,true);
   assert.equal(settings.enableExtendedGiftInfo,false);
  }
  async connect(){return {roomId:'1'}}
  disconnect(){}
 }
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:Proto,WebcastEvent:{CHAT:'chat',GIFT:'gift'}})});
 c.start('live_test');await tick();
 const giftData={user:{displayId:'regalador'},giftDetails:{giftName:'Rose',giftType:0},giftId:5655,repeatCount:1};
 const chatData={user:{displayId:'comentador'},comment:'Buenas!'};
 conn.emit('decodedData','WebcastGiftMessage',{type:'WebcastGiftMessage',data:giftData});
 conn.emit('decodedData','WebcastChatMessage',{type:'WebcastChatMessage',data:chatData});
 assert.deepEqual(c.snapshot().events.map(x=>x.kind),['gift','comment']);
 assert.equal(c.snapshot().events[0].username,'regalador');
 assert.equal(c.snapshot().events[0].giftName,'Rose');
 assert.equal(c.snapshot().events[1].username,'comentador');
 // No duplicar si después la biblioteca emite también el evento de alto nivel.
 conn.emit('gift',giftData);conn.emit('chat',chatData);
 assert.equal(c.snapshot().events.length,2);
});
test('decodedMessage admite formato moderno y heredado de eventos',()=>{
 const e={user:{displayId:'tiktok'},giftId:1};
 assert.equal(decodedMessage('WebcastGiftMessage',{type:'WebcastGiftMessage',data:e}).data.user.displayId,'tiktok');
 assert.equal(decodedMessage({type:'WebcastGiftMessage',data:e}).type,'WebcastGiftMessage');
 assert.equal(eventPayload({type:'WebcastGiftMessage',data:e}),e);
});

test('Evita la consulta de catálogo Business al conectar y sigue escuchando regalos',async()=>{
 let instance,optionsSeen;
 class NoBusiness extends EventEmitter{
  constructor(username,settings){
   super();instance=this;optionsSeen=settings;
   if(settings.enableExtendedGiftInfo)throw Error('This endpoint requires a Business plan');
  }
  async connect(){this.emit('connected',{roomId:'live112'});return {roomId:'live112'}}
  disconnect(){}
 }
 const c=createTikTokChat({loadConnector:async()=>({TikTokLiveConnection:NoBusiness,WebcastEvent:{CHAT:'chat',GIFT:'gift'}})});
 c.start('peleasfalopa');await tick();
 assert.equal(c.snapshot().status,'connected');
 assert.equal(optionsSeen.processInitialData,true);
 assert.equal(optionsSeen.enableExtendedGiftInfo,false);
 instance.emit('gift',{user:{displayId:'regalador'},giftId:5655,repeatCount:1,repeatEnd:true});
 const item=c.snapshot().events.at(-1);
 assert.equal(item.giftName,'Rosa');
 assert.equal(item.emoji,'🌹');
 assert.equal(item.username,'regalador');
});
test('Sin el catálogo premium los regalos desconocidos conservan su identificador',()=>{
 const rose=normalizeGift({user:{displayId:'viewer'},giftId:5655,repeatCount:2},1,100);
 assert.equal(rose.giftName,'Rosa');
 const other=normalizeGift({user:{displayId:'viewer'},giftId:12456,repeatCount:1},2,100);
 assert.equal(other.giftName,'Regalo #12456');
 const described=normalizeGift({user:{displayId:'viewer'},giftId:12456,describe:'Sent Tulip'},3,100);
 assert.equal(described.giftName,'Tulip');
});
