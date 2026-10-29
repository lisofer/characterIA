import {GoogleGenAI, Modality} from '@google/genai';
import {allSettings,getProfile,updateField,updateIdentity,addEvent,saveDoc,listDocs} from './db.js';
import {cvReadiness,upsertExperience,upsertEducation,experienceEntries,validExperience,firstJob} from './cv-layout.js';
import {createDocument} from './pdf.js';
const VOICE_NAMES=['Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat'];
export {VOICE_NAMES};
const fnDefinitions=[
 {name:'consultar_perfil',description:'Consulta todos los datos ya registrados; no repetir preguntas sobre información conocida.'},
 {name:'registrar_identidad',description:'Guarda nombre y apellido JUNTOS cuando la persona diga su nombre completo, evitando duplicación. Si hay dos o más posibles separaciones de nombres/apellidos, preguntá cuál es correcta una sola vez.',parameters:{type:'OBJECT',properties:{nombre:{type:'STRING',description:'Nombre de pila, sin el apellido'},apellido:{type:'STRING',description:'Apellido o apellidos, sin repetir nombre'},confirmado:{type:'BOOLEAN',description:'true si la persona lo dijo claramente o aceptó la separación propuesta'}},required:['nombre','apellido','confirmado']}},
 {name:'actualizar_dato',description:'Guarda información confirmada. Para EXPERIENCIA LABORAL usá registrar_experiencia: no guardes trabajos sin fechas ni organización en texto libre. Solo se permite usar experiencia para registrar que busca el primer empleo.',parameters:{type:'OBJECT',properties:{campo:{type:'STRING',enum:['nombre','apellido','localidad','direccion','telefono','correo','objetivo','perfil_profesional','formacion','experiencia','habilidades','idiomas','cursos','otros']},valor:{type:'STRING'},confirmado:{type:'BOOLEAN'}},required:['campo','valor','confirmado']}},
 {name:'registrar_experiencia',description:'Guarda un empleo, changa, práctica, tarea comunitaria o experiencia no remunerada CON puesto, nombre real de empresa/organización o contexto, meses y años aproximados confirmados y actividades. Antes de llamar, hacé preguntas de a una para completar todo. Para corregir una experiencia existente usá reemplazar_indice empezando en 1.',parameters:{type:'OBJECT',properties:{
 puesto:{type:'STRING',description:'Título PROFESIONAL, breve y fiel a lo que hizo (p. ej. «Auxiliar de panadería» en lugar de «ayudante de un panadero»), propuesto oralmente y aprobado por la persona. No inventar jerarquías.'},
 lugar:{type:'STRING',description:'Empresa, empleador, institución, domicilio particular, trabajo por cuenta propia o contexto real confirmado'},
 ubicacion:{type:'STRING',description:'Localidad o ciudad si la conoce'},
 inicio_mes:{type:'INTEGER',description:'Mes de inicio del 1 al 12, estimado y confirmado por la persona'},
 inicio_anio:{type:'INTEGER',description:'Año de inicio confirmado'},
 fin_mes:{type:'INTEGER',description:'Mes final entre 1 y 12 si ya terminó'},
 fin_anio:{type:'INTEGER',description:'Año de finalización si ya terminó'},
 actual:{type:'BOOLEAN',description:'true si sigue haciendo esa actividad en la actualidad'},
 actividades:{type:'STRING',description:'Responsabilidades verificadas redactadas con VERBOS profesionales y precisos, separadas por punto y coma (por ej. «Entrega de pedidos a domicilio» en lugar de «llevar comida»). Antes de guardar, ofrecer ejemplos mejor escritos y pedir confirmación. No inventar habilidades técnicas, herramientas, logros ni jerarquías.'},
 aproximada:{type:'BOOLEAN',description:'true si alguna de las fechas es una estimación confirmada'},
 reemplazar_indice:{type:'INTEGER',description:'Solo si corrige una experiencia: posición 1, 2, etc. Omitir para agregar'},
 migracion_confirmada:{type:'BOOLEAN',description:'true cuando existe un trabajo antiguo en texto libre, ya se revisó con la persona y confirmó que puede reemplazarse por este registro organizado'},
 redaccion_profesional_aprobada:{type:'BOOLEAN',description:'true ÚNICAMENTE cuando le propusiste explícitamente un título y tareas bien redactados y la persona los aceptó'},
 confirmado:{type:'BOOLEAN',description:'true únicamente después de que la persona confirme estos datos'}
 },required:['puesto','lugar','inicio_mes','inicio_anio','actual','actividades','confirmado']}},
 {name:'registrar_formacion',description:'Guarda estudios con institución y fechas aproximadas solo cuando se conocen; permite primaria, secundaria, cursos y talleres. No presumas títulos ni egreso. Podés omitir fechas si no logra recordarlas.',parameters:{type:'OBJECT',properties:{
 titulo:{type:'STRING'},institucion:{type:'STRING'},inicio_mes:{type:'INTEGER'},inicio_anio:{type:'INTEGER'},
 fin_mes:{type:'INTEGER'},fin_anio:{type:'INTEGER'},en_curso:{type:'BOOLEAN'},estado:{type:'STRING'},
 aproximada:{type:'BOOLEAN'},reemplazar_indice:{type:'INTEGER'},migracion_confirmada:{type:'BOOLEAN'},confirmado:{type:'BOOLEAN'}
 },required:['titulo','institucion','confirmado']}},
 {name:'generar_cv',description:'Cuando la persona confirma el CV, genera únicamente un archivo PDF. Su descarga se solicita automáticamente.',parameters:{type:'OBJECT',properties:{confirmacion:{type:'BOOLEAN'}},required:['confirmacion']}}

];
const shortProfile=p=>p?JSON.stringify({
 nombreCompleto:[p.fields.nombre,p.fields.apellido].filter(Boolean).join(' '),
 campos:p.fields,
 camposYaRecogidos:Object.keys(p.fields).filter(k=>String(p.fields[k]??'').trim()),
 primeraCharla:Object.values(p.fields).every(v=>!String(v??'').trim()),
 ultimasRespuestas:p.recentEvents.filter(e=>e.type==='usuario'||e.type==='usuario_texto').slice(-5).map(e=>e.content.slice(0,320))
}):'{}';
const getAI=()=>{if(!process.env.GEMINI_API_KEY)throw new Error('Falta configurar GEMINI_API_KEY en Railway.');return new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});};
const fallbackable=e=>/429|RESOURCE_EXHAUSTED|quota|credit|billing|404|NOT_FOUND|model.*unavailable|model.*not found/i.test([e?.message,e?.reason,e?.code,String(e)].join(' '));
export function makeLive(client,profileId,{voiceOverride,preview=false}={}){
 let live=null,closed=false,chosen='',userTranscript='',botTranscript='',bufferedAudio=false,fallbacking=false;

 const cfg=allSettings();
 const write=(type,data={})=>{try{if(client.readyState===1)client.send(JSON.stringify({type,...data}));}catch{}};
 const tools=preview?[]:[{functionDeclarations:fnDefinitions}];
 const profile=getProfile(profileId);
 // El único prompt editable se guarda como settings.prompt. El perfil se adjunta como contexto dinámico.
 async function handleTools(calls){const responses=[];
  for(const call of calls||[]){let result={ok:false,error:'Función desconocida'};try{
    if(call.name==='consultar_perfil'){result={ok:true,datos:getProfile(profileId)?.fields||{}};}
    else if(call.name==='registrar_identidad'){
      if(call.args?.confirmado!==true)result={ok:false,mensaje:'Si el nombre y los apellidos son ambiguos, preguntá solo cómo se separan.'};
      else{
        const n=String(call.args?.nombre||'').trim(),a=String(call.args?.apellido||'').trim();
        const saved=updateIdentity(profileId,n,a);
        result={ok:true,nombre:saved.nombre,apellido:saved.apellido};
        write('profile',{profile:getProfile(profileId)?.fields||{}});
      }
    }
    else if(call.name==='actualizar_dato'){
      if(call.args?.confirmado!==true)
       result={ok:false,requiere_confirmacion:true,mensaje:'Repetí el dato con palabras simples y preguntá si lo entendiste bien.'};
      else if(call.args?.campo==='nombre'&&String(call.args?.valor||'').trim().split(/\s+/).length>=3&&!getProfile(profileId)?.fields?.apellido)
       result={ok:false,mensaje:'El nombre completo tiene varias palabras. Pedí una sola confirmación sobre cuáles son nombres y cuáles apellidos; luego usá registrar_identidad.'};
      else if(call.args?.campo==='experiencia'&&!firstJob(call.args.valor||'')&&
       !(experienceEntries(call.args.valor).length&&experienceEntries(call.args.valor).every(validExperience)))
       result={ok:false,mensaje:'Para una experiencia laboral, reuní puesto, lugar, mes/año de inicio y fin y tareas, y utilizá registrar_experiencia. Preguntá de a una cosa; podés ayudar a recordar fechas con acontecimientos de su vida. No inventes meses.'};
      else result={ok:true,cambio:updateField(profileId,call.args.campo,call.args.valor)};
      if(result.ok)write('profile',{profile:getProfile(profileId)?.fields||{}});
    }else if(call.name==='registrar_experiencia'){
      if(call.args?.confirmado!==true)
       result={ok:false,requiere_confirmacion:true,mensaje:'Leé una síntesis breve de los datos y preguntá si son correctos antes de guardarlos.'};
      else{
       const actual=getProfile(profileId)?.fields?.experiencia||'';
       const saved=upsertExperience(actual,call.args,call.args?.reemplazar_indice||0);
       if(!saved.ok)result={ok:false,faltantes:saved.faltantes,
         propuesta_puesto:saved.sugerencia_puesto||undefined,
         propuestas_tareas:saved.sugerencias_tareas||undefined,
         mensaje:saved.requiere_redaccion?'No guardes literalmente el habla informal. Leé la propuesta profesional, explicá que es una forma de presentar su experiencia y preguntá si la aprueba. Luego registrá la redacción aceptada con redaccion_profesional_aprobada:true.':'Falta completar información. Pedí únicamente el primer dato pendiente y ayudá a recordarlo sin inventarlo.'};
       else{
        updateField(profileId,'experiencia',saved.valor);
        result={ok:true,experiencias:saved.experiencias,mensaje:'Experiencia guardada con título y actividades revisados. Explicá brevemente una habilidad que demuestra y cómo se relaciona con el trabajo que busca, luego avanzá con naturalidad.'};
        write('profile',{profile:getProfile(profileId)?.fields||{}});
       }
      }
    }else if(call.name==='registrar_formacion'){
      if(call.args?.confirmado!==true)
       result={ok:false,requiere_confirmacion:true,mensaje:'Confirmá con la persona el estudio y su institución.'};
      else{
       const actual=getProfile(profileId)?.fields?.formacion||'';
       const saved=upsertEducation(actual,call.args,call.args?.reemplazar_indice||0);
       if(!saved.ok)result={ok:false,faltantes:saved.faltantes};
       else{
        updateField(profileId,'formacion',saved.valor);
        result={ok:true,estudios:saved.estudios};
        write('profile',{profile:getProfile(profileId)?.fields||{}});
       }
      }
    }else if(call.name==='generar_cv'){
      if(call.args?.confirmacion!==true)result={ok:false,mensaje:'Primero resumí la versión del CV y preguntá si está conforme.'};
      else{
        const profile=getProfile(profileId),check=cvReadiness(profile?.fields||{});
        if(!check.ok)result={ok:false,faltantes:check.faltantes,mensaje:'Ya hay información registrada. Consultala y pedí solo el primer dato realmente pendiente, de manera natural y con una breve explicación.'};
        else{
          const file=await createDocument(profileId);
          const id=saveDoc(profileId,file.filename);
          const nombre=[profile.fields.nombre,profile.fields.apellido].filter(Boolean).join(' ').trim();
          write('document',{id,format:'pdf',filenameBase:(nombre||'Curriculum')+' CV'});
          result={ok:true,mensaje:'El archivo PDF está preparado y se solicitó su descarga al navegador. No afirmes que se descargó hasta poder comprobarlo.'};
        }
      }
    }
   }catch(e){result={ok:false,error:String(e.message||e)};}
   responses.push({id:call.id,name:call.name,response:{result}});
  }
  if(!closed && live && responses.length)live.sendToolResponse({functionResponses:responses});
 }
 const config={responseModalities:[Modality.AUDIO],outputAudioTranscription:{},inputAudioTranscription:{},speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:voiceOverride||cfg.voice}}},tools};
 // Solo el prompt del administrador define la conversación.
 // Las funciones y el perfil son datos técnicos, no un segundo guion.
 const buildConfig=()=>({...config,systemInstruction:{parts:[{text:cfg.prompt+'\n\nDATOS DEL PERFIL YA CONOCIDOS (NO PREGUNTARLOS DE NUEVO):\n'+shortProfile(getProfile(profileId))}]}});

 async function switchFallback(e){if(fallbacking||closed||chosen!==cfg.model||!cfg.fallback||cfg.fallback===cfg.model||!fallbackable(e))return false;fallbacking=true;write('notice',{message:'Se agotó o no está disponible el modelo principal. Cambiando a la voz de respaldo…'});try{live?.close();await connect([cfg.fallback]);live.sendClientContent({turns:[{role:'user',parts:[{text:'[RECONEXIÓN DE SESIÓN]'}]}],turnComplete:true});return true;}catch(err){write('error',{message:'También falló el modelo de respaldo: '+String(err?.message||err)});return false;}finally{fallbacking=false;}}
 async function connect(overrideModels=null){const modelList=overrideModels||[cfg.model,cfg.fallback].filter((v,i,a)=>v&&a.indexOf(v)===i);
  let lastError;
  for(const model of modelList){try{
    const ai=getAI();
    live=await ai.live.connect({model,config:buildConfig(),callbacks:{
      onopen:()=>{},
      onmessage:async m=>{
        try{
          if(m.toolCall?.functionCalls)await handleTools(m.toolCall.functionCalls);
          const sc=m.serverContent||{};
          const output=sc.outputTranscription?.text;
          const input=sc.inputTranscription?.text;
          if(input){userTranscript+=input;write('input_transcript',{text:input});}
          if(output){botTranscript+=output;write('transcript',{text:output});}
          const parts=sc.modelTurn?.parts||[];
          for(const part of parts){if(part.inlineData?.data){bufferedAudio=true;write('audio',{pcm:part.inlineData.data,mimeType:part.inlineData.mimeType||'audio/pcm;rate=24000'});}}
          if(sc.interrupted){write('interrupted');botTranscript='';}
          if(sc.turnComplete){
            
            if(userTranscript.trim()&&!preview)addEvent(profileId,'usuario',userTranscript.trim());
            if(botTranscript.trim()&&!preview)addEvent(profileId,'asistente',botTranscript.trim());
            userTranscript='';botTranscript='';bufferedAudio=false;write('turn_complete');
          }
        }catch(err){write('error',{message:String(err.message||err)});}
      },
      onerror:e=>{if(closed||fallbacking)return;void switchFallback(e).then(switched=>{if(!switched)write('error',{message:String(e?.message||e)})});},
      onclose:e=>{if(!closed&&!fallbacking){void switchFallback(e).then(switched=>{if(!switched)write('closed',{message:e?.reason||'Sesión terminada. Podés iniciar una nueva llamada.'})})}}
    }});
    chosen=model;write('connected',{model,voice:voiceOverride||cfg.voice,fallback:model!==cfg.model});return model;
   }catch(e){lastError=e;if(model===cfg.model && fallbackable(e))continue;break;}}
  throw lastError||new Error('No se pudo conectar con Gemini Live');
 }
 return {connect,sendText(text){if(!live)throw new Error('No está conectado');live.sendClientContent({turns:[{role:'user',parts:[{text:String(text).slice(0,3000)}]}],turnComplete:true});if(!preview)addEvent(profileId,'usuario_texto',text);},
 sendAudio(data){if(live&&typeof data==='string'&&data.length<120000)live.sendRealtimeInput({audio:{data,mimeType:'audio/pcm;rate=16000'}});},
 stopAudio(){if(live)live.sendRealtimeInput({audioStreamEnd:true});},
 initial(){if(!live)throw new Error('No está conectado');live.sendClientContent({turns:[{role:'user',parts:[{text:'[INICIO DE SESIÓN]'}]}],turnComplete:true});},
 close(){closed=true;try{live?.close()}catch{}}};
}
// Muestra de voz mediante el mismo Gemini Live que usa la conversación.
export async function voiceSample(voice){const ai=getAI();const cfg=allSettings();let session=null;
 const models=[cfg.model,cfg.fallback].filter((v,i,a)=>v&&a.indexOf(v)===i);
 for(const model of models){try{return await new Promise(async(resolve,reject)=>{
  const chunks=[];let finished=false;const done=(err,result)=>{if(finished)return;finished=true;clearTimeout(timer);try{session?.close()}catch{};err?reject(err):resolve(result);};
  const timer=setTimeout(()=>done(new Error('La muestra de voz excedió el tiempo disponible')),30000);
  try{session=await ai.live.connect({model,config:{responseModalities:[Modality.AUDIO],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:voice}}},systemInstruction:{parts:[{text:'Leé exactamente esta frase en español de Argentina con naturalidad y no agregues palabras.'}]}},callbacks:{
    onopen:()=>{},onmessage:m=>{for(const p of m.serverContent?.modelTurn?.parts||[])if(p.inlineData?.data)chunks.push(Buffer.from(p.inlineData.data,'base64'));if(m.serverContent?.turnComplete)done(null,{model,bytes:Buffer.concat(chunks)});},onerror:e=>done(new Error(String(e?.message||e))),onclose:()=>{if(!finished)done(new Error('Sesión cerrada'))}
  }});session.sendClientContent({turns:[{role:'user',parts:[{text:'Hola, soy tu asistente. Vamos a preparar tu currículum juntos, a tu ritmo.'}]}],turnComplete:true});}
  catch(e){done(e);}
 });}catch(e){if(model===cfg.model&&fallbackable(e))continue;throw e;}}
 throw new Error('No se pudo probar la voz');}
export function wav(pcm,sampleRate=24000){const b=Buffer.alloc(44+pcm.length);b.write('RIFF',0);b.writeUInt32LE(36+pcm.length,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(sampleRate,24);b.writeUInt32LE(sampleRate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(pcm.length,40);pcm.copy(b,44);return b;}
