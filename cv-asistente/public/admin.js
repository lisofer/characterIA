'use strict';
const $=id=>document.getElementById(id);
const labels=['Reposo · abiertos','Reposo · cerrados','Boca A · abiertos','Boca A · cerrados','Boca O · abiertos','Boca O · cerrados','Boca E · abiertos','Boca E · cerrados'];
let config=null;
async function api(path,options={}){
 const response=await fetch(path,{credentials:'same-origin',...options});
 const raw=await response.text();
 let data={};try{data=raw?JSON.parse(raw):{}}catch{data={error:raw.slice(0,180)}}
 if(!response.ok){
  if(response.status===401){$('adminPanel').hidden=true;$('adminLogin').hidden=false;$('adminLoginError').textContent='Tu sesión de administrador terminó. Volvé a ingresar.'}
  throw Error(data.error||(response.status===403?'No tenés permiso para esta acción. Comprobá el inicio de sesión.':'Error HTTP '+response.status));
 }
 return data;
}
const json=(method,body)=>({method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
function val(form,key,value){const e=form.elements.namedItem(key);if(e)e.value=value??''}
function displayImages(){
 const root=$('imagesGrid');root.replaceChildren();
 const loaded=labels.filter((_label,i)=>config.images?.[i]||config.images?.[String(i)]).length;
 const counter=$('pngProgress');if(counter)counter.textContent=loaded+' de 8 imágenes cargadas';
 labels.forEach((title,i)=>{
  const card=document.createElement('article');card.className='image-slot';card.dataset.slot=String(i);
  const preview=document.createElement('div');preview.className='image-preview';
  const saved=config.images?.[i]||config.images?.[String(i)];
  if(saved){const img=document.createElement('img');img.alt='Vista previa: '+title;img.src='/api/assets/'+i+'?v='+saved;img.loading='lazy';preview.append(img);card.classList.add('is-filled')}
  else{const face=document.createElement('span');face.className='image-placeholder';face.setAttribute('aria-hidden','true');face.textContent='✦';preview.append(face)}
  const titleEl=document.createElement('b');titleEl.className='slot-title';titleEl.textContent=title;
  const num=document.createElement('span');num.className='slot-number';num.textContent=String(i+1).padStart(2,'0');
  const input=document.createElement('input');input.type='file';input.accept='image/png,.png';input.id='slot-file-'+i;input.className='visually-hidden-upload';input.setAttribute('aria-label','Seleccionar PNG para '+title);
  const uploadLabel=document.createElement('label');uploadLabel.htmlFor=input.id;uploadLabel.className='upload-action';uploadLabel.textContent=saved?'Reemplazar PNG':'Subir PNG';
  const feedback=document.createElement('p');feedback.className='slot-feedback';feedback.setAttribute('role','status');feedback.textContent=saved?'Imagen cargada':'Sin imagen';
  input.addEventListener('change',async()=>{
   const file=input.files?.[0];if(!file)return;
   if(!/\.png$/i.test(file.name)){feedback.textContent='Elegí un archivo .png';feedback.classList.add('error');input.value='';return}
   if(file.size>5*1024*1024){feedback.textContent='La imagen supera los 5 MB';feedback.classList.add('error');input.value='';return}
   const data=new FormData();data.append('image',file);
   input.disabled=true;uploadLabel.classList.add('is-loading');uploadLabel.textContent='Subiendo…';
   feedback.classList.remove('error');feedback.textContent='Guardando '+file.name+'…';
   try{
    const uploaded=await api('/api/admin/images/'+i,{method:'POST',body:data});
    config.images[String(i)]=Number(new URL(uploaded.url,location.href).searchParams.get('v'))||Date.now();
    displayImages();
    const newCard=root.querySelector('[data-slot="'+i+'"]');
    if(newCard){newCard.classList.add('just-saved');const status=newCard.querySelector('.slot-feedback');if(status)status.textContent='PNG guardado correctamente'}
    $('saveStatus').textContent='Imagen '+(i+1)+' guardada. No hace falta guardar otra vez.';
   }catch(err){
    feedback.classList.add('error');
    feedback.textContent=err.message.includes('sesión')?'Volvé a ingresar como administrador.':err.message;
    uploadLabel.textContent='Reintentar subida';
    uploadLabel.classList.remove('is-loading');
    input.disabled=false;
    input.value='';
   }
  });
  card.append(num,preview,titleEl,input,uploadLabel,feedback);root.append(card);
 });
}
function updateRange(){for(const [name,out] of [['fish.temperature','temperatureVal'],['fish.topP','topPVal'],['fish.speed','speedVal'],['fish.volume','volumeVal']]){$(out).textContent=Number($('settingsForm').elements.namedItem(name).value).toFixed(out==='volumeVal'?0:2)}}
function setConfig(c){config=c;const form=$('settingsForm');for(const name of ['title','characterName','durationMinutes','introText','personality','pedagogy','geminiModel'])val(form,name,c[name]);for(const name of ['model','referenceId','temperature','topP','speed','volume'])val(form,'fish.'+name,c.fish?.[name]);for(const name of ['accent','style'])val(form,'template.'+name,c.template?.[name]);$('apiStatus').textContent='Variables en Render: Gemini '+(c.env.gemini?'configurada':'sin configurar')+' · Fish '+(c.env.fish?'configurada':'sin configurar')+'. Las claves permanecen en el servidor.';displayImages();updateRange()}
function collect(){const f=$('settingsForm');const g=name=>f.elements.namedItem(name).value;return{title:g('title'),characterName:g('characterName'),durationMinutes:Number(g('durationMinutes')),introText:g('introText'),personality:g('personality'),pedagogy:g('pedagogy'),geminiModel:g('geminiModel'),fish:{model:g('fish.model'),referenceId:g('fish.referenceId'),temperature:Number(g('fish.temperature')),topP:Number(g('fish.topP')),speed:Number(g('fish.speed')),volume:Number(g('fish.volume'))},template:{accent:g('template.accent'),style:g('template.style')}}}
function cell(label,value){const d=document.createElement('div');d.textContent=label+': '+value;return d}
function minutes(n){return (Number(n||0)/60).toFixed(1)+' min'}
async function showUsage(){try{const data=await api('/api/admin/usage');const v=data.summary;const s=$('usageSummary');s.replaceChildren(cell('Entrevistas',v.sessions),cell('CV generados',v.pdfCount),cell('Audio reproducido (informado por navegador)',minutes(v.audioPlayedSeconds)),cell('Micrófono (informado por navegador)',minutes(v.micSeconds)),cell('Caracteres Fish TTS',v.ttsChars.toLocaleString('es-AR')),cell('Llamadas Fish',v.ttsCalls),cell('Tokens Gemini entrada',v.geminiInputTokens.toLocaleString('es-AR')),cell('Tokens Gemini salida',v.geminiOutputTokens.toLocaleString('es-AR')));
const list=$('sessionsList');list.replaceChildren();if(!data.sessions.length){list.textContent='Todavía no hay entrevistas.';return}
for(const t of data.sessions){const card=document.createElement('div');card.className='session-item';const title=document.createElement('b');title.textContent=t.name;const date=cell('Fecha',new Date(t.createdAt).toLocaleString('es-AR'));const time=cell('Tiempo transcurrido',t.elapsedMinutes+' min');const usage=cell('Audio escuchado / micrófono',minutes(t.usage.audioPlayedSeconds)+' / '+minutes(t.usage.micSeconds));const stage=cell('Estado',t.pdfCreated?'CV terminado':t.stage);const tools=document.createElement('div');tools.className='tools';
if(t.pdfCreated){const a=document.createElement('a');a.href='/api/admin/cvs/'+encodeURIComponent(t.id)+'/pdf';a.textContent='Descargar CV';a.download='CV-'+t.id.slice(0,8)+'.pdf';tools.append(a)}
const del=document.createElement('button');del.className='secondary';del.type='button';del.textContent='Borrar';del.addEventListener('click',async()=>{if(!confirm('¿Borrar definitivamente esta entrevista y su PDF?'))return;try{await api('/api/admin/sessions/'+t.id,{method:'DELETE'});showUsage()}catch(e){alert(e.message)}});tools.append(del);card.append(title,date,time,usage,stage,tools);list.append(card)}}
catch(e){$('sessionsList').textContent='No se pudieron cargar los registros: '+e.message}}
async function openPanel(){const c=await api('/api/admin/config');$('adminLogin').hidden=true;$('adminPanel').hidden=false;setConfig(c);$('shareLink').value=location.origin+'/';await showUsage()}
$('adminLoginForm').addEventListener('submit',async e=>{e.preventDefault();$('adminLoginError').textContent='';try{await api('/api/login',json('POST',{role:'admin',password:$('adminPassword').value}));await openPanel()}catch(err){$('adminLoginError').textContent=err.message}});
$('settingsForm').addEventListener('submit',async e=>{e.preventDefault();$('saveStatus').textContent='Guardando…';try{const d=await api('/api/admin/config',json('PUT',collect()));config={...d.config,env:config.env};$('saveStatus').textContent='Configuración guardada correctamente (almacenamiento temporal de Render Free)';setTimeout(()=>{$('saveStatus').textContent=''},5000)}catch(err){$('saveStatus').textContent=err.message}});
for(const name of ['fish.temperature','fish.topP','fish.speed','fish.volume'])$('settingsForm').elements.namedItem(name).addEventListener('input',updateRange);
$('refreshUsage').addEventListener('click',showUsage);
$('testVoice').addEventListener('click',async()=>{const btn=$('testVoice');btn.disabled=true;$('previewStatus').textContent='Generando audio…';try{const r=await fetch('/api/admin/preview-voice',json('POST',{text:$('previewText').value}));if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||'Falló Fish');const audio=$('previewAudio');if(audio.dataset.blobUrl)URL.revokeObjectURL(audio.dataset.blobUrl);audio.src=URL.createObjectURL(await r.blob());audio.dataset.blobUrl=audio.src;audio.hidden=false;await audio.play();$('previewStatus').textContent='Voz de prueba generada con la configuración guardada.'}catch(e){$('previewStatus').textContent=e.message}finally{btn.disabled=false}});
$('copyLink').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('shareLink').value);$('copyLink').textContent='Enlace copiado';setTimeout(()=>$('copyLink').textContent='Copiar enlace',1800)}catch{$('shareLink').select()}});
$('logout').addEventListener('click',async()=>{await api('/api/logout?role=admin',{method:'POST'});location.reload()});
api('/api/me?role=admin').then(me=>{if(me.role==='admin')openPanel()}).catch(()=>{});
