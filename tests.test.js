'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
process.env.PORT='31339';
process.env.APP_ACCESS_TOKEN='test-token-exclusivamente-local-de-35-chars';
process.env.SESSION_SECRET='secret-for-tests-only-extremely-long-abcdefg';
process.env.GEMINI_API_KEY='gemini-private-key-tests';
process.env.FISH_API_KEY='fish-private-key-tests';
const {pack,server,geminiURL}=require('./server');
const fetchLocal=global.fetch;const outbound=[];
global.fetch=async(url,options={})=>{
 if(String(url).startsWith('https://api.fish.audio/')){outbound.push({url,options});return new Response(Buffer.from('FAKE-MP3'),{status:200,headers:{'Content-Type':'audio/mpeg'}})}
 if(String(url).startsWith('https://generativelanguage.googleapis.com/')){outbound.push({url,options});if(String(url).includes('streamGenerateContent'))return new Response('data: {"candidates":[{"content":{"parts":[{"text":"Hola"}]}}]}\n\n',{status:200,headers:{'Content-Type':'text/event-stream'}});return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'hola, transcripción'}]}}]}),{status:200})}
 return fetchLocal(url,options)
};
const BASE='http://127.0.0.1:31339';
const post=(url,body,cookie,extra={})=>fetchLocal(BASE+url,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra},body:JSON.stringify(body)});
let session='';
after(()=>{global.fetch=fetchLocal;server.close()});
test('Sin sesión la app y APIs no funcionan',async()=>{
 const main=await fetchLocal(BASE+'/',{redirect:'manual'});assert.equal(main.status,302);
 assert.equal((await fetchLocal(BASE+'/api/health')).status,401);
 assert.equal((await post('/api/fish/tts',{text:'hola'})).status,401)
});
test('Login rechaza credenciales y origen inválidos',async()=>{
 assert.equal((await post('/api/auth/login',{token:'mal'})).status,401);
 assert.equal((await post('/api/auth/login',{token:process.env.APP_ACCESS_TOKEN},null,{Origin:'https://evil.example'})).status,403)
});
test('Login correcto devuelve cookie firmada HttpOnly',async()=>{
 const r=await post('/api/auth/login',{token:process.env.APP_ACCESS_TOKEN});
 assert.equal(r.status,200);const h=r.headers.get('set-cookie');assert.match(h,/HttpOnly/);assert.match(h,/SameSite=Strict/);assert.doesNotMatch(h,/test-token-exclusivamente-local/);session=h.split(';')[0]
});
test('HTML y health protegidos sin exponer secretos',async()=>{
 const r=await fetchLocal(BASE+'/',{headers:{Cookie:session}});assert.equal(r.status,200);
 const h=await r.text();assert.ok(h.includes('Persona Studio'));assert.ok(!h.includes('gemini-private-key-tests'));assert.ok(!h.includes("$('apiKey')"));assert.ok(!h.includes("$('fishKey')"));
 const c=await (await fetchLocal(BASE+'/api/health',{headers:{Cookie:session}})).json();assert.equal(c.geminiKeyConfigured,true);assert.equal(c.fishKeyConfigured,true)
});
test('Fish TTS usa clave del servidor',async()=>{
 const r=await post('/api/fish/tts',{text:'Hola',reference_id:'voice_abc'},session);assert.equal(r.status,200);assert.equal(await r.text(),'FAKE-MP3');
 assert.equal(outbound.at(-1).options.headers.Authorization,'Bearer fish-private-key-tests')
});
test('Fish reference requiere texto',async()=>{
 const audio=Buffer.from('audio-reference');let r=await post('/api/fish/tts',{text:'Hola',reference_audio:audio.toString('base64')},session);assert.equal(r.status,400);
 r=await post('/api/fish/tts',{text:'Hola',reference_audio:audio.toString('base64'),reference_text:'Audio de prueba'},session);assert.equal(r.status,200)
});
test('Gemini streaming y transcripción usan variables servidor',async()=>{
 let r=await post('/api/gemini/stream',{model:'gemini-3.5-flash-lite',payload:{contents:[{role:'user',parts:[{text:'hola'}]}]}},session);
 assert.equal(r.status,200);assert.match(await r.text(),/Hola/);
 assert.equal(outbound.at(-1).options.headers['x-goog-api-key'],'gemini-private-key-tests');
 r=await post('/api/gemini/transcribe',{model:'gemini-3.5-flash-lite',payload:{contents:[{role:'user',parts:[{text:'transcribir'}]}]}},session);assert.equal(r.status,200);assert.match(await r.text(),/transcripción/)
});
test('Cookies falsificadas, CSRF, modelo inválido y logout',async()=>{
 assert.equal((await fetchLocal(BASE+'/api/health',{headers:{Cookie:session+'tampered'}})).status,401);
 assert.equal(geminiURL('https://evil.com',true),null);
 assert.equal((await post('/api/fish/tts',{text:'hola'},session,{Origin:'https://evil.example'})).status,403);
 const r=await post('/api/auth/logout',{},session);assert.match(r.headers.get('set-cookie'),/Max-Age=0/)
});
test('MessagePack incluye audio binario',()=>{assert.ok(pack({b:Buffer.from('test')}).includes(Buffer.from('test')))});
