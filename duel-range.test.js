'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return html.slice(a,b)}
const ranges=new Function('const stripSpeech=t=>String(t||\'\').trim();\n'+section('function duelLimitRange(text){','function newDuelTopic(){')+
 section('function duelParseBatch(response,min,max){','// El susurro es una nota')+
 ';return {duelLimitRange,duelLimitBounds,duelParseBatch};');
const {duelLimitRange,duelLimitBounds,duelParseBatch}=ranges();
const parse=(response,min,max)=>duelParseBatch(response,min,max);
test('Rangos de intervenciones válidos, incluyendo un único turno',()=>{
 assert.deepEqual(duelLimitRange('1-12'),{min:1,max:12});
 assert.deepEqual(duelLimitRange('6–12'),{min:6,max:12});
 assert.deepEqual(duelLimitRange('1-1'),{min:1,max:1});
 for(const bad of ['12-6','0-12','1-31','1-','abc'])assert.equal(duelLimitRange(bad),null);
 assert.deepEqual(duelLimitBounds({limit:6}),{min:1,max:12});
 assert.deepEqual(duelLimitBounds({limitMin:6,limitMax:12}),{min:6,max:12});
});
test('Gemini devuelve cantidad variable dentro del rango, sin completar a un número fijo',()=>{
 assert.equal(parse('{"lines":["Una sola intervención"]}',1,12).length,1);
 assert.equal(parse(JSON.stringify({lines:Array(9).fill('Hola')}),6,12).length,9);
 assert.throws(()=>parse('{"lines":["Muy pocas"]}',6,12),/rango permitido/);
 assert.throws(()=>parse(JSON.stringify({lines:Array(13).fill('Demasiadas')}),1,12),/rango permitido/);
});
test('Limpieza visual mantiene el fondo editable por clic',()=>{
 assert.ok(!html.includes('id="duelExport"'));
 assert.ok(!html.includes('id="duelSceneBackground"'));
 assert.ok(!html.includes('<footer class="key-help">'));
 assert.ok(html.includes("!e.target.closest('.duel-character'))openSceneChooser('broadcast')"));
 assert.ok(html.includes("id=\"duelLimitRange\""));
});
