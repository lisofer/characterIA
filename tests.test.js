'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
process.env.PORT='3101';
const {pack,server}=require('./server');
const base='http://127.0.0.1:3101';
const originalFetch=global.fetch;
const upstream=[];
global.fetch=async(url,opts={})=>{
 if(String(url).startsWith('https://api.fish.audio/')){
  upstream.push({url,opts});
  return new Response(new Uint8Array([0x49,0x44,0x33,0x04,0,0]),{status:200,headers:{'Content-Type':'audio/mpeg'}});
 }
 return originalFetch(url,opts);
};
after(()=>{global.fetch=originalFetch;server.close()});
test('GET health',async()=>{const r=await originalFetch(base+'/api/health');assert.equal(r.status,200);assert.equal((await r.json()).model,'s2.1-pro-free')});
test('GET web app',async()=>{const r=await originalFetch(base+'/');assert.equal(r.status,200);assert.ok((await r.text()).includes('fishKey'))});
test('Reject Fish without API key',async()=>{const r=await originalFetch(base+'/api/fish/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Hola'})});assert.equal(r.status,401)});
test('Fish TTS with ID and model',async()=>{
 const r=await originalFetch(base+'/api/fish/tts',{method:'POST',headers:{'x-fish-key':'TEST_KEY','Content-Type':'application/json'},body:JSON.stringify({text:'Hola, soy Rocío.',reference_id:'VOICE_123',speed:1.15,latency:'low'})});
 assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'audio/mpeg');
 const last=upstream.at(-1);assert.equal(last.opts.headers.model,'s2.1-pro-free');assert.ok(Buffer.from(last.opts.body).includes(Buffer.from('VOICE_123')));
});
test('Fish TTS with voice reference and literal transcript',async()=>{
 const audio=Buffer.from('test-voice');
 const r=await originalFetch(base+'/api/fish/tts',{method:'POST',headers:{'x-fish-key':'TEST_KEY','Content-Type':'application/json'},body:JSON.stringify({text:'Hola',reference_audio:audio.toString('base64'),reference_text:'Texto exacto.'})});
 assert.equal(r.status,200);const sent=Buffer.from(upstream.at(-1).opts.body);assert.ok(sent.includes(audio));assert.ok(sent.includes(Buffer.from('Texto exacto.')));
});
test('Reject reference without transcript',async()=>{const r=await originalFetch(base+'/api/fish/tts',{method:'POST',headers:{'x-fish-key':'TEST_KEY','Content-Type':'application/json'},body:JSON.stringify({text:'Hola',reference_audio:Buffer.from('xx').toString('base64')})});assert.equal(r.status,400)});
test('MessagePack binary bytes',()=>{const buf=pack({name:'voz',samples:[{audio:Buffer.from('test')} ]});assert.ok(buf.includes(Buffer.from('test')))});
