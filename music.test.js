'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {targetVolume,fadedVolume,MAX_BYTES}=require('./music-runtime');
test('Volumen y reducción automática',()=>{
 assert.equal(targetVolume(20,22,false),.2);
 assert.ok(Math.abs(targetVolume(20,22,true)-.044)<1e-9);
 assert.equal(targetVolume(110,0,true),0);
 assert.equal(targetVolume(-10,0,false),0);
 assert.equal(MAX_BYTES,19000000);
});
test('Subir y bajar volumen progresivamente',()=>{
 const down=fadedVolume(.2,.04,100,true),up=fadedVolume(.04,.2,100,false);
 assert.ok(down<.2&&down>.04);assert.ok(up>.04&&up<.2);
});
