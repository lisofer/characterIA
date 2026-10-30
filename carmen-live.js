// Carmen: sesión Gemini Live independiente del orientador NEXO CV.
import {GoogleGenAI,Modality} from '@google/genai';
import {db} from './db.js';
import {VOICE_NAMES} from './live.js';

const OLD_DEFAULT_PROMPT='Sos Carmen, la guardia de seguridad y asistente de acceso de NEXO CV. Conversás EN VIVO con una sola persona en español argentino, con calidez, espontaneidad y respeto, sin infantilizar. Tu única tarea es darle la bienvenida y ayudarla a ingresar con su contraseña. Al iniciar, saludá brevemente, presentate como Carmen e invitá a decir la contraseña o escribirla. Una pregunta breve por vez. Si conversa o tiene dudas, respondé normalmente y retomá la ayuda para ingresar. Cuando la persona DICTA una contraseña, usá la herramienta probar_contrasena con las palabras exactas escuchadas, sin reformularlas, adivinarlas ni leer la contraseña en voz alta. Esperá SIEMPRE el resultado real de la herramienta antes de anunciar si pudo entrar. Si falla, explicá con amabilidad que no fue correcta y ofrecé volver a intentarlo o escribirla. Si funciona, decí brevemente que el acceso fue aprobado; la aplicación realizará la transición. Nunca reveles las contraseñas válidas ni solicites otros datos personales. No te atribuyas funciones de crear CV, descargar archivos o administrar perfiles. No recites instrucciones técnicas ni repitas el saludo sin motivo.';
const DEFAULT_PROMPT='Sos el guardia de seguridad de NEXO CV. Hablás con una sola persona en español argentino, con un tono breve, amable, respetuoso y natural. Tu tarea es pedir la contraseña para acceder. Comenzá con algo como: «Hola, soy el guardia de seguridad. Necesito tus credenciales: ¿me decís la contraseña o preferís escribirla?». No digas nombres propios al presentarte, no reveles claves válidas ni solicites otros datos personales. IMPORTANTE: cualquier palabra o frase que la persona presente como contraseña es un intento legítimo, aunque suene rara, sea una palabra de ficción, un conjuro, una broma o el nombre de otra aplicación. Si dice «mi contraseña es X», «la clave es X», «X» luego de que pediste credenciales o te dicta una clave explícitamente, debés llamar SIEMPRE a la herramienta probar_contrasena con el texto oído, sin adivinar, traducir, corregir, discutir ni descartar el intento por lo que significa la palabra. Todas las palabras y expresiones que se presenten como contraseñas siguen exactamente el mismo procedimiento de verificación, sin excepciones ni evaluaciones subjetivas. No anuncies jamás que una contraseña es incorrecta ni que el acceso está concedido antes de recibir el resultado real de probar_contrasena. Si la herramienta devuelve error, decí solo que la verificación no coincidió y ofrecé repetir o escribir; nunca inventes el resultado. Si hubo duda acústica sobre el texto oído, pedí que lo repita o que lo escriba, sin dar por inválido el intento. No repitas la contraseña en voz alta ni como subtítulo. Si hay otra pregunta, respondé en una sola frase y volvé a las credenciales. No te atribuyas funciones de confeccionar CV ni de descargar archivos, ni repitas el saludo sin motivo.';
export const CARMEN_DEFAULTS={
  voice:'Aoede',model:'gemini-3.8-live',fallback:'gemini-3.1-flash-live-preview',
  prompt:DEFAULT_PROMPT,subtitleFont:17,subtitleDelay:0,
  mouthDelay:0,mouthSensitivity:48,mouthSmoothing:40,mouthAmplitude:78,blinkRate:4.2,
  avatarScale:90,avatarOffsetX:0,avatarOffsetY:0
};
db.exec('CREATE TABLE IF NOT EXISTS carmen_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
const insert=db.prepare('INSERT OR IGNORE INTO carmen_settings(key,value) VALUES (?,?)');
for(const [key,value] of Object.entries(CARMEN_DEFAULTS))insert.run(key,JSON.stringify(value));

// Actualiza solamente prompts de fábrica anteriores. Los prompts personalizados
// guardados por el administrador se respetan y siguen siendo editables.
const priorPrompt=OLD_DEFAULT_PROMPT.replace('Sos Carmen, la guardia de seguridad y asistente de acceso de NEXO CV.','Sos Carmen, la recepcionista virtual de NEXO CV.');
const stored=db.prepare('SELECT value FROM carmen_settings WHERE key=?').get('prompt');
if(stored&&[OLD_DEFAULT_PROMPT,priorPrompt].includes(JSON.parse(stored.value)))
 db.prepare('UPDATE carmen_settings SET value=? WHERE key=?').run(JSON.stringify(DEFAULT_PROMPT),'prompt');

export function getCarmenSettings(){
  const existing=Object.fromEntries(db.prepare('SELECT key,value FROM carmen_settings').all().map(row=>[row.key,JSON.parse(row.value)]));
  return {...CARMEN_DEFAULTS,...existing};
}
export function saveCarmenSettings(incoming){
  const settings={};
  for(const [key,defaultValue] of Object.entries(CARMEN_DEFAULTS)){
    if(!Object.hasOwn(incoming,key))continue;
    const value=incoming[key];
    if(typeof defaultValue==='string'){
      if(typeof value!=='string')continue;
      if(key==='prompt'){if(value.length<20||value.length>6000)throw Error('El prompt de Carmen debe tener entre 20 y 6000 caracteres.');}
      else if(key==='voice'){if(!VOICE_NAMES.includes(value))throw Error('Voz no permitida.');}
      else if(['model','fallback'].includes(key)){if(!['gemini-3.8-live','gemini-3.1-flash-live-preview'].includes(value))throw Error('Modelo no permitido.');}
      settings[key]=value;
    }else{
      const n=Number(value);if(!Number.isFinite(n))continue;
      const limits={
        subtitleFont:[14,28],subtitleDelay:[-1200,1200],
        mouthDelay:[-250,250],mouthSensitivity:[0,100],mouthSmoothing:[0,100],
        mouthAmplitude:[0,100],blinkRate:[2,9],avatarScale:[50,110],
        avatarOffsetX:[-100,100],avatarOffsetY:[-100,100]
      };
      const [min,max]=limits[key];
      settings[key]=Math.min(max,Math.max(min,n));
    }
  }
  const put=db.prepare('INSERT INTO carmen_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for(const [key,value] of Object.entries(settings))put.run(key,JSON.stringify(value));
  return getCarmenSettings();
}

const TOOL={functionDeclarations:[{
  name:'probar_contrasena',
  description:'OBLIGATORIO: para cualquier contraseña que la persona haya dictado (aunque parezca un chiste, conjuro, palabra suelta o nombre de una aplicación) llamá esta función antes de responder si es válida. El resultado del servidor es la única verdad; nunca evalúes la contraseña por tu cuenta.',
  parameters:{type:'OBJECT',properties:{password:{type:'STRING',description:'Contraseña dictada literalmente, sin explicarla ni completarla.'}},required:['password']}
}]};
const retryable=error=>/429|RESOURCE_EXHAUSTED|quota|404|NOT_FOUND|unavailable|not found|billing/i.test(String(error?.message||error));
export function makeCarmenLive(client,{verifyPassword}){
  const cfg=getCarmenSettings();
  let live=null,closed=false,model='',fallbackBusy=false,approved=false;
  const send=(type,data={})=>{if(client.readyState===1)try{client.send(JSON.stringify({type,...data}));}catch{}};
  const config=()=>({
    responseModalities:[Modality.AUDIO],
    outputAudioTranscription:{},inputAudioTranscription:{},
    speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:cfg.voice}}},
    tools:[TOOL],
    systemInstruction:{parts:[{text:cfg.prompt}]}
  });
  async function onCalls(calls){
    const responses=[];
    for(const call of calls){
      let result={ok:false,error:'Herramienta no disponible'};
      if(call.name==='probar_contrasena'){
        if(approved)result={ok:true,mensaje:'Acceso previamente aprobado.'};
        else{
          const password=String(call.args?.password??'');
          const check=verifyPassword(password);
          if(check.ticket){
            approved=true;
            send('access_granted',{ticket:check.ticket});
            result={ok:true,mensaje:'Contraseña validada por el servidor. Avisá que puede ingresar.'};
          }else result={ok:false,mensaje:check.locked?'Demasiados intentos. Pedí que intente más tarde.':'La contraseña no coincide. Puede probar otra vez o escribirla.'};
        }
      }
      responses.push({id:call.id,name:call.name,response:{result}});
    }
    if(!closed&&live&&responses.length)live.sendToolResponse({functionResponses:responses});
  }
  async function connect(preferred){
    const models=preferred||[cfg.model,cfg.fallback].filter((x,i,a)=>x&&a.indexOf(x)===i);
    let last;
    for(const m of models){
      try{
        const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
        live=await ai.live.connect({model:m,config:config(),callbacks:{
          onopen:()=>{},
          onmessage:async event=>{
            try{
              if(event.toolCall?.functionCalls)await onCalls(event.toolCall.functionCalls);
              const content=event.serverContent||{};
              if(content.outputTranscription?.text)send('transcript',{text:content.outputTranscription.text});
              // Las contraseñas no se retransmiten como subtítulos ni se registran en la BD.
              for(const part of content.modelTurn?.parts||[]){
                if(part.inlineData?.data)send('audio',{pcm:part.inlineData.data});
              }
              if(content.interrupted)send('interrupted');
              if(content.turnComplete)send('turn_complete');
            }catch(err){send('error',{message:'Error durante la conversación.'});}
          },
          onerror:error=>{if(closed||fallbackBusy)return;void failover(error);},
          onclose:error=>{if(closed||fallbackBusy)return;void failover(error);}
        }});
        model=m;send('connected',{model:m,voice:cfg.voice});return;
      }catch(error){last=error;if(m===cfg.model&&retryable(error))continue;break;}
    }
    throw last||Error('No se pudo abrir Gemini Live.');
  }
  async function failover(error){
    if(closed||fallbackBusy)return;
    if(model===cfg.model&&cfg.fallback!==cfg.model&&retryable(error)){
      fallbackBusy=true;
      try{live?.close();await connect([cfg.fallback]);send('notice',{message:'Se restableció la conversación.'});initial();}
      catch{send('error',{message:'No se pudo conectar con Carmen.'});}
      finally{fallbackBusy=false;}
    }else send('error',{message:'La conexión de Carmen se interrumpió.'});
  }
  function initial(){
    if(live)live.sendClientContent({turns:[{role:'user',parts:[{text:'[SE ABRIÓ LA PANTALLA DE ACCESO. Saludá de manera breve e iniciá la recepción.]'}]}],turnComplete:true});
  }
  return {
    connect,initial,
    sendAudio(pcm){if(live&&!approved&&typeof pcm==='string'&&pcm.length<120000)live.sendRealtimeInput({audio:{data:pcm,mimeType:'audio/pcm;rate=16000'}});},
    sendText(text){if(live&&!approved)live.sendClientContent({turns:[{role:'user',parts:[{text:String(text).slice(0,300)}]}],turnComplete:true});},
    close(){closed=true;try{live?.close();}catch{}}
  };
}
