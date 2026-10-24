'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const SpeechInput=require('../public/speech-utils.js');

test('WebSpeech duplicate growing hypotheses are merged once',()=>{
 const results=[
  [{transcript:'No'}],
  [{transcript:'No tengo'}],
  [{transcript:'No tengo experiencia'}],
  [{transcript:'No tengo experiencia y nunca trabajé'}]
 ];
 assert.equal(SpeechInput.snapshot(results),'No tengo experiencia y nunca trabajé');
});
test('WebSpeech events do not accumulate previous transcripts',()=>{
 const event1=[[{transcript:'No'}]];
 const event2=[[{transcript:'No tengo experiencia'}]];
 assert.equal(SpeechInput.snapshot(event1),'No');
 assert.equal(SpeechInput.snapshot(event2),'No tengo experiencia');
});
test('Repeated voice hallucination is reduced but natural negation preserved',()=>{
 assert.equal(SpeechInput.dedupe('No no tengo experiencia no no tengo experiencia'),'No no tengo experiencia');
 assert.equal(SpeechInput.dedupe('No no no no no no no tengo experiencia'),'No no tengo experiencia');
});
test('Subtitle fragments contain assistant text only and stay within one line',()=>{
 const code=fs.readFileSync(path.join(__dirname,'../public/lipsync.js'),'utf8');
 const env={window:{}};vm.runInNewContext(code,env);
 const p=env.window.PersonaLipSync.build('Hola, vamos a crear un currículum. Contame qué actividades hiciste en la escuela y qué cosas disfrutás aprender.');
 const caps=env.window.PersonaLipSync.captions(p);
 assert.ok(caps.length>=2);
 assert.ok(caps.every(x=>x.text.length<=72&&!x.text.includes('\n')));
 const early=env.window.PersonaLipSync.caption(p,350,8000);
 const later=env.window.PersonaLipSync.caption(p,7800,8000);
 assert.ok(early.length>0&&later.length>0);
});
