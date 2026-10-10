'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {targetVolume,fadedVolume,normalizeMusic,assetKey,MAX_BYTES}=require('./music-runtime');
test('Volumen y reducción automática',()=>{
 assert.equal(targetVolume(20,22,false),.2);
 assert.ok(Math.abs(targetVolume(20,22,true)-.044)<1e-9);
 assert.equal(targetVolume(110,0,true),0);
 assert.equal(targetVolume(-10,0,false),0);
 assert.equal(MAX_BYTES,100*1024*1024);
});
test('Bajada y recuperación progresivas',()=>{
 const down=fadedVolume(.2,.04,100,true),up=fadedVolume(.04,.2,100,false);
 assert.ok(down<.2&&down>.04);assert.ok(up>.04&&up<.2);
});
test('La canción anterior se conserva como parte de la biblioteca',()=>{
 const m=normalizeMusic({name:'mi fondo.mp3',size:120,updatedAt:123,volume:17});
 assert.equal(m.tracks.length,1);assert.equal(m.tracks[0].name,'mi fondo');
 assert.equal(m.selectedId,'legacy');assert.equal(m.volume,17);
 assert.equal(assetKey('legacy'),'music:background');
});
test('La biblioteca admite varias pistas y conserva los borrados',()=>{
 const m=normalizeMusic({tracks:[{id:'t_first',name:'A.mp3',size:12,addedAt:10},{id:'t_second',name:'B',deletedAt:44}],selectedId:'t_second'});
 assert.equal(m.selectedId,'t_first');
 assert.equal(m.tracks[1].deletedAt,44);
 assert.equal(assetKey('t_first'),'music:track:t_first');
});
