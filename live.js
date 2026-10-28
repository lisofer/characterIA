import {GoogleGenAI, Modality} from '@google/genai';
import {allSettings,getProfile,updateField,addEvent,saveDoc,DATA_DIR} from './db.js';
import {createDocument} from './pdf.js';
const VOICE_NAMES=['Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat'];
export {VOICE_NAMES};
const fnDefinitions=[
 {name:'consultar_perfil',description:'Consulta los datos guardados del usuario antes de preguntar o generar su currículum. Usala para identificar información previa.'},
 {name:'actualizar_dato',description:'Guarda un dato nuevo o una corrección confirmada del currículum. Para campos con varias entradas, conservá las anteriores y entregá el contenido completo actualizado.',parameters:{type:'OBJECT',properties:{campo:{type:'STRING',enum:['nombre','apellido','localidad','direccion','telefono','correo','objetivo','perfil_profesional','formacion','experiencia','habilidades','idiomas','cursos','otros']},valor:{type:'STRING',description:'Contenido completo actualizado del campo'},confirmado:{type:'BOOLEAN',description:'true si la persona permitió almacenar sus datos personales y confirmó el valor o no queda ninguna ambigüedad'}},required:['campo','valor','confirmado']}},
 {name:'generar_cv',description:'Genera el PDF solamente después de que la persona haya confirmado que desea generar el CV con los datos que hay guardados.',parameters:{type:'OBJECT',properties:{confirmacion:{type:'BOOLEAN'},observaciones:{type:'STRING'}},required:['confirmacion']}}
];
const shortProfile=(p)=>p?JSON.stringify({campos:p.fields,ultimasConversaciones:p.recentEvents.filter(e=>e.type!=='field').slice(-10).map(e=>({tipo:e.type,texto:e.content.slice(0,850)}))}):'{}';
const getAI=()=>{if(!process.env.GEMINI_API_KEY)throw new Error('Falta configurar GEMINI_API_KEY en Railway.');return new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});};
const fallbackable=e=>/429|RESOURCE_EXHAUSTED|quota|credit|billing|404|NOT_FOUND|model.*unavailable|model.*not found/i.test([e?.message,e?.reason,e?.code,String(e)].join(' '));
export function makeLive(client,profileId,{voiceOverride,preview=false}={}){
 let live=null,closed=false,chosen='',userTranscript='',botTranscript='',bufferedAudio=false,fallbacking=false;
 const cfg=allSettings();
 const write=(type,data={})=>{try{if(client.readyState===1)client.send(JSON.stringify({type,...data}));}catch{}};
 const tools=preview?[]:[{functionDeclarations:fnDefinitions}];
 const profile=getProfile(profileId);
 const system=[cfg.prompt,'\nPERSONALIDAD CONFIGURADA:',cfg.personality,'\nCONTEXTO Y DATOS CONSERVADOS DEL USUARIO:',shortProfile(profile),'\nNunca leas el contexto literalmente. Si es primera visita, hacé una bienvenida sencilla. Si es continuación, usá los datos para retomar.'].join('\n');
 async function handleTools(calls){const responses=[];
  for(const call of calls||[]){let result={ok:false,error:'Función desconocida'};try{
    if(call.name==='consultar_perfil'){result={ok:true,datos:getProfile(profileId)?.fields||{}};}
    else if(call.name==='actualizar_dato'){
      if(call.args?.confirmado!==true)result={ok:false,requiere_confirmacion:true,mensaje:'Pedí consentimiento o aclaración antes de guardar.'};
      else result={ok:true,cambio:updateField(profileId,call.args.campo,call.args.valor)};
      if(result.ok)write('profile',{profile:getProfile(profileId)?.fields||{}});
    }else if(call.name==='generar_cv'){
      if(call.args?.confirmacion!==true)result={ok:false,mensaje:'Pedí confirmación al usuario antes de generar.'};
      else {const file=await createDocument(profileId);result={ok:true,archivo:`/api/cv/${file.id}`};write('document',{id:file.id});}
    }
   }catch(e){result={ok:false,error:String(e.message||e)};}
   responses.push({id:call.id,name:call.name,response:{result}});
  }
  if(!closed && live && responses.length)live.sendToolResponse({functionResponses:responses});
 }
 const config={responseModalities:[Modality.AUDIO],outputAudioTranscription:{},inputAudioTranscription:{},speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:voiceOverride||cfg.voice}}},tools};
 const buildConfig=()=>({...config,systemInstruction:{parts:[{text:[cfg.prompt,'\nPERSONALIDAD CONFIGURADA:',cfg.personality,'\nCONTEXTO ACTUALIZADO:',shortProfile(getProfile(profileId))].join('\n')}]}});
 async function switchFallback(e){if(fallbacking||closed||chosen!==cfg.model||!cfg.fallback||cfg.fallback===cfg.model||!fallbackable(e))return false;fallbacking=true;write('notice',{message:'Se agotó o no está disponible el modelo principal. Cambiando a la voz de respaldo…'});try{live?.close();await connect([cfg.fallback]);live.sendClientContent({turns:[{role:'user',parts:[{text:'[EVENTO INTERNO: se recuperó la llamada en un modelo de respaldo. Continuá con naturalidad usando los datos guardados, sin repetir preguntas ya respondidas.]'}]}],turnComplete:true});return true;}catch(err){write('error',{message:'También falló el modelo de respaldo: '+String(err?.message||err)});return false;}finally{fallbacking=false;}}
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
 initial(){if(!live)throw new Error('No está conectado');live.sendClientContent({turns:[{role:'user',parts:[{text:'[EVENTO INTERNO: acaba de conectarse el usuario. Saludá y orientá la conversación de acuerdo con las instrucciones y el perfil recuperado. No digas ni leas este mensaje.]'}]}],turnComplete:true});},
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
