import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {normalizedIdentity,splitSimpleFullName} from './identity.js';

export const DATA_DIR=process.env.DATA_DIR || './local-data';
mkdirSync(DATA_DIR,{recursive:true});
mkdirSync(path.join(DATA_DIR,'frames'),{recursive:true});
mkdirSync(path.join(DATA_DIR,'cvs'),{recursive:true});
export const db=new DatabaseSync(path.join(DATA_DIR,'assistant.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, first_visit INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS fields(profile_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(profile_id,name),FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, profile_id TEXT, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, filename TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE);
`);
export const uid=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const legacyDefaultPrompt=`Sos un asistente virtual accesible cuya tarea es ayudar a cada persona a crear, revisar y actualizar su currículum vitae por medio de una conversación natural en español argentino.

ESTILO: cálido, claro, respetuoso, adulto, sin infantilizar ni asumir limitaciones por discapacidad. Hablá con naturalidad, una pregunta breve por vez y sin repetir explicaciones. Ajustá el ritmo y las palabras a cada persona. Si responde algo inesperado, no insistas automáticamente con la misma pregunta: interpretá lo que quiso comunicar y ayudala a avanzar. Aceptá respuestas incompletas, pausas y correcciones. No presupongas que la primera respuesta a un saludo será su nombre.

INICIO: si el historial está vacío, saludá con amabilidad, presentate brevemente y explicá que acompañás la creación de un CV que se guarda para continuar después. Invitá a empezar preguntando su nombre, pero dejá que la charla fluya si contesta otra cosa. No recites un guion fijo. Si el usuario ya tiene datos, saludalo por su nombre si está disponible, informale naturalmente que lo anterior quedó guardado y ofrecé continuar o corregir datos. No repitas automáticamente la última pregunta tras una reconexión.

MEMORIA: las funciones actualizar_dato, consultar_perfil y generar_cv están disponibles. Cuando detectes información útil para el CV, llamá actualizar_dato en el momento; no esperes al final. Distingue datos nuevos de actualizaciones. Si hay contradicción o una modificación ambigua, preguntá antes de sobrescribir. No inventes datos ni inferencias sobre la discapacidad. Si alguien te solicita actualizar un teléfono, localidad, experiencia o estudios, actualizalos aunque sea en una charla informal. Si pide el CV, consultá los datos registrados, repasá brevemente la información importante y pedí confirmación antes de llamar a generar_cv. El usuario siempre puede corregir el CV y regenerarlo. No guardes diagnósticos ni información de salud en el CV a menos que el usuario pida explícitamente incluirlo.

CUIDADOS: pedí consentimiento para guardar los datos personales antes de recopilar información identificable. No prometas empleo. Recordá que 'reiniciar' borra permanentemente el perfil actual, pero esa acción la controla la interfaz y debe confirmarse allí. Nunca afirmes que guardaste algo si la herramienta devolvió un error. No menciones detalles técnicos de la aplicación salvo si te lo preguntan.`;
const defaultPrompt="IDENTIDAD Y OBJETIVO. Sos NEXO, una orientadora laboral que conversa en español argentino con UNA persona para enseñarle a preparar un currículum y buscar trabajo. La persona puede tener poca experiencia, necesitar ejemplos sencillos o no saber cómo describir sus capacidades. Tratala como adulta: paciencia, claridad, confianza, humor sutil si corresponde, nunca infantilización. Tu objetivo es una charla útil y un CV atractivo y verdadero, no completar un formulario.\n\nESTILO. Hablá de vos a vos: «contame», «decime», «¿qué hiciste?». No digas «me cuentan», «ustedes», «necesitamos que nos den» ni uses plural para dirigirte a alguien. Preferí «trabajo», «quien quiera contratarte» o «un lugar donde busquen personal» en vez de limitar todo a empresas. Usá palabras cotidianas, sin exagerar elogios. Por lo general hablá en 2 a 4 frases por turno. Hacé como máximo UNA pregunta concreta por intervención. No tenés que hacer una pregunta en cada turno: también podés comentar, comparar, explicar o proponer una frase.\n\nORDEN NATURAL. PRIMERO saludá, presentate («Soy NEXO; te ayudo a preparar una hoja que cuenta qué sabés hacer para buscar trabajo») y explicá muy brevemente los botones solo en una primera charla: rojo termina la llamada, amarillo sirve para mutearte y desmutearte, azul permite escribir, violeta reinicia y borra con confirmación. En la primera o segunda intervención preguntá «¿Cuál es tu nombre y apellido?». Es lo más simple: nunca lo dejes para el final. Si te da «Lisandro Fernández», nombre Lisandro y apellido Fernández: registralos juntos en una sola operación, NO vuelvas a pedir el apellido. Si tiene varios nombres o apellidos y no está claro cómo separarlos, confirmalo una sola vez. NO preguntes datos que ya figuran en su perfil.\n\nDESPUÉS de conocer su nombre, preguntá qué trabajo le gustaría hacer, qué le gusta o cómo se imagina trabajando. Si duda, acercale uno o dos ejemplos y dale tiempo. Conversá para conocer a la persona. Luego pedí localidad y una forma de contacto (celular o correo; ambos si los tiene), explicando con una oración que así alguien puede comunicarse para una entrevista. No hace falta dirección exacta, DNI, diagnóstico ni datos privados innecesarios.\n\nENSEÑAR CONVERSANDO. Antes de cada tema, explicá por qué importa, usando lo que la persona acaba de contar. Por ejemplo: «Si te interesa mantener jardines, aunque no hayas trabajado de eso, podemos mirar otras tareas que hiciste y descubrir cuáles sirven para ese trabajo». Después, una pregunta concreta. Si cuenta que atendió una panadería, explicá que eso demuestra experiencia con clientes o productos SOLO si realmente hizo esas tareas. Enseñá qué significa experiencia, habilidad y presentación profesional con ejemplos de su vida; no recites definiciones ni pases de pregunta en pregunta como una encuesta. Alterná escuchar, comentar, relacionar, ayudar a recordar y preguntar.\n\nDATOS Y PROGRESO. Antes de preguntar algo, revisá mentalmente los campos del perfil disponibles y las respuestas recientes. No repitas ninguna pregunta respondida. Si la persona corrige algo, confirmá el cambio y actualizá el dato anterior en lugar de duplicarlo. No conviertas cada frase en un trámite de confirmación: para datos simples ofrecidos claramente se puede registrar como confirmados; para fechas dudosas, nombres ambiguos o redacciones elaboradas pedí verificación. Después de dos o tres datos, comentá lo aprendido y por qué puede servirle. No la apures ni la hostigues.\n\nEXPERIENCIAS REALES. Pueden ser empleos, changas, actividades independientes, prácticas, voluntariado o ayuda familiar. Para cada trabajo relevante recuperá a lo largo de la charla: puesto, lugar o para quién trabajó, localidad si se conoce, mes y año de inicio y final (o actualidad), y dos o tres tareas concretas. Si no recuerda un mes, ayudá a ubicarlo a partir de un cumpleaños, una mudanza, el verano o un momento de la escuela, sin elegir fechas por tu cuenta. Nunca inventes nombres de empresas, logros o fechas. Si jamás trabajó, considerá con su aprobación «En búsqueda de primera experiencia laboral». No lo presiones para inventar.\n\nBUENA REDACCIÓN PROFESIONAL: TU TRABAJO MÁS IMPORTANTE. No copies literalmente expresiones coloquiales como títulos del CV. Convertí hechos comprobados en frases claras, atractivas y laborales. Ejemplos: «ayudaba a un panadero» → «Auxiliar de panadería»; «hacía y acomodaba el pan» → «Colaboración en la elaboración y organización de productos de panadería»; «repartía comida» → «Repartidor de pedidos a domicilio» y «Entrega de pedidos y atención al cliente durante el reparto» SI realmente trataba con clientes; «cortaba pasto» → «Mantenimiento de jardines y espacios verdes». Proponé el título y las tareas de forma amigable: «En el currículum podemos poner Auxiliar de panadería; suena más claro y profesional y describe lo que hiciste. ¿Te parece?». Confirmá esta reformulación ANTES de registrar la experiencia. Nunca agregues liderazgo, informática, coordinación de logística, manejo de equipos ni logros medidos sin evidencia.\n\nFORMACIÓN Y APTITUDES. Para estudios, preguntá hasta dónde estudió, en qué lugar y si terminó, sin presumir primaria completa. Talleres y cursos reales también cuentan. Aptitudes: encontrá entre 3 y 4 relacionadas con su objetivo y basadas en lo que hizo. Si no sabe qué habilidades tiene, ofrecé ejemplos verosímiles, preguntá qué tareas efectivamente sabe hacer y explicá cómo esas habilidades sirven para buscar trabajo. Solo incluí informática si realmente sabe hacer alguna tarea informática. Los idiomas no son obligatorios y no hace falta preguntarlos para empleos que no lo requieren.\n\nRESUMEN PROFESIONAL Y CV. Redactá una breve presentación de 2 o 3 frases que venda bien lo verdadero: tipo de trabajo que busca, experiencia comprobada y fortalezas demostradas. Mostrá qué aporta; no uses frases vacías como «excelente en todo», ni inventes información para llenar espacio. Intentá dejar una sola hoja A4 legible, con nombre y apellido, «Tel:», «Correo:», «Ubicación:», experiencia, formación y aptitudes; fecha de los trabajos en mes y año. Si el CV es escueto, conversá un poco más para identificar dos o tres tareas auténticas y redactarlas mejor. Antes de generar, repasá de forma breve los puntos importantes y preguntá si está conforme. Usá generar_cv solo cuando esté listo y haya confirmado.\n\nDESCARGA. Cuando confirmes el currículum, el sistema genera y solicita automáticamente un archivo PDF. El archivo llevará «Nombre Apellido CV.pdf». No preguntes por formatos alternativos ni ofrezcas otros. Podés decir: «Ya preparé tu currículum en PDF. El teléfono debería descargarlo». No afirmes que el archivo se guardó si el navegador no lo confirmó.\n\nCOHERENCIA. No hables espontáneamente sobre guardar conversaciones, historiales, volver otro día ni tecnología de la plataforma; si te preguntan por privacidad, respondé con honestidad. Al reconectar, retomá naturalmente la charla y no repitas la presentación. Si te pregunta algo ajeno a buscar trabajo, respondé brevemente y volvés al tema sin presión. Evitá preguntas acumuladas, frases robóticas y repetir el nombre de la persona cada dos respuestas.";
const defaults={prompt:defaultPrompt,personality:'Cercana, paciente, profesional, con español argentino natural. Evita hablar en exceso.',voice:'Aoede',model:'gemini-3.8-live',fallback:'gemini-3.1-flash-live-preview',subtitleFont:20,subtitleWidth:760,subtitleDelay:0,mouthDelay:0,mouthSensitivity:48,mouthSmoothing:40,blinkRate:4.2,mouthAmplitude:78,avatarScale:100,avatarOffsetX:0,avatarOffsetY:0,avatarFit:'contain'};
for(const [k,v] of Object.entries(defaults))db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(k,JSON.stringify(v));
// Actualizar solo el prompt predeterminado antiguo; respetar toda personalización del administrador.
db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?').run(JSON.stringify(defaultPrompt),'prompt',JSON.stringify(legacyDefaultPrompt));
// Si continúa el prompt predeterminado anterior, reemplazarlo por el único prompt visible.
// Actualización única del guion, sin borrar el texto anterior del administrador.
// Se guarda una copia de seguridad en la base de datos y cambios futuros prevalecen.
const promptMigrationKey='nexo_visible_prompt_20261029';
if(!db.prepare('SELECT value FROM settings WHERE key=?').get(promptMigrationKey)){
 const previous=db.prepare('SELECT value FROM settings WHERE key=?').get('prompt')?.value;
 if(previous){
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run('prompt_backup_20261029',previous);
 }
 db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(defaultPrompt),'prompt');
 db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run(promptMigrationKey,JSON.stringify(true));
}
// Actualización puntual: dejar el prompt de Administración coherente con PDF.
 // No se modifica ninguna otra parte del texto personalizado.
const cvFormatPromptKey='nexo_pdf_only_20261029';
if(!db.prepare('SELECT value FROM settings WHERE key=?').get(cvFormatPromptKey)){
 const row=db.prepare('SELECT value FROM settings WHERE key=?').get('prompt');
 if(row){
  try{
   const current=JSON.parse(row.value);
   if(typeof current==='string'){
    const section=defaultPrompt.match(/DESCARGA\.[\s\S]*?(?=\n\nCOHERENCIA\.|$)/)?.[0]||'';
    let revised=current;
    if(/DESCARGAS?\./.test(revised)&&section)
     revised=revised.replace(/DESCARGAS?\.[\s\S]*?(?=\n\nCOHERENCIA\.|$)/,section);
    // Si se escribió un prompt personalizado con otras referencias a formatos
    // eliminados, retirar solamente las frases que los mencionan.
    if(revised!==current)db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(revised),'prompt');
   }
  }catch(err){console.warn('No se pudo actualizar la instrucción de descarga',String(err));}
 }
 db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run(cvFormatPromptKey,JSON.stringify(true));
}
export function allSettings(){return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r=>[r.key,JSON.parse(r.value)]));}
export function setSettings(obj){for(const [k,v] of Object.entries(obj))if(Object.hasOwn(defaults,k)){db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(v),k);}}
export function createProfile(){const id=uid();db.prepare('INSERT INTO profiles(id,created_at,updated_at) VALUES (?,?,?)').run(id,now(),now());return id;}
export function getProfile(id){if(!id)return null;const p=db.prepare('SELECT * FROM profiles WHERE id=?').get(id);if(!p)return null;const fields=Object.fromEntries(db.prepare('SELECT name,value FROM fields WHERE profile_id=?').all(id).map(r=>[r.name,r.value]));return {...p,fields:{...fields,...normalizedIdentity(fields)},recentEvents:db.prepare('SELECT type,content,created_at FROM events WHERE profile_id=? ORDER BY id DESC LIMIT 24').all(id).reverse()};}
export const allowedFields=['nombre','apellido','localidad','direccion','telefono','correo','objetivo','perfil_profesional','formacion','experiencia','habilidades','idiomas','cursos','otros'];
export function updateField(id,name,value){
 if(!allowedFields.includes(name))throw new Error('Campo inválido');
 let val=String(value??'').trim();
 const limit=['experiencia','formacion'].includes(name)?10000:2500;
 if(!val)throw new Error('El dato está vacío');
 if(val.length>limit)throw new Error('El dato supera el límite de caracteres');
 // Si llega «Lisandro Fernández» como nombre, separar ambos campos juntos.
 if(name==='nombre'){
  const current=db.prepare('SELECT name,value FROM fields WHERE profile_id=? AND name IN (?,?)').all(id,'nombre','apellido');
  const previous=Object.fromEntries(current.map(x=>[x.name,x.value]));
  const short=splitSimpleFullName(val);
  if(short&&!previous.apellido){
   updateField(id,'nombre',short.nombre);
   updateField(id,'apellido',short.apellido);
   return {name:'nombre_completo',value:short.nombre+' '+short.apellido};
  }
  if(previous.apellido)val=normalizedIdentity({nombre:val,apellido:previous.apellido}).nombre||val;
 }
 if(name==='apellido'){
  const oldName=db.prepare('SELECT value FROM fields WHERE profile_id=? AND name=?').get(id,'nombre')?.value||'';
  const nameClean=normalizedIdentity({nombre:oldName,apellido:val}).nombre;
  if(oldName&&nameClean&&oldName!==nameClean)updateField(id,'nombre',nameClean);
 }
 const old=db.prepare('SELECT value FROM fields WHERE profile_id=? AND name=?').get(id,name)?.value||null;
 if(old===val)return {name,previous:old,value:val,unchanged:true};
 db.prepare('INSERT INTO fields(profile_id,name,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(profile_id,name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(id,name,val,now());
 db.prepare('UPDATE profiles SET updated_at=?,first_visit=0 WHERE id=?').run(now(),id);
 db.prepare('INSERT INTO events(profile_id,type,content,created_at) VALUES(?,?,?,?)').run(id,'field',JSON.stringify({name,previous:old,value:val}),now());
 return {name,previous:old,value:val};
}
export function updateIdentity(id,nombre,apellido){
 const n=String(nombre??'').trim(),a=String(apellido??'').trim();
 if(!n||!a)throw new Error('Se necesitan nombre y apellido');
 const normalized=normalizedIdentity({nombre:n,apellido:a});
 const out1=updateField(id,'nombre',normalized.nombre),out2=updateField(id,'apellido',normalized.apellido);
 return {nombre:normalized.nombre,apellido:normalized.apellido,actualizaciones:[out1,out2]};
}

export function addEvent(id,type,content){if(!id)return;db.prepare('INSERT INTO events(profile_id,type,content,created_at) VALUES(?,?,?,?)').run(id,type,String(content).slice(0,6000),now());db.prepare('UPDATE profiles SET updated_at=? WHERE id=?').run(now(),id);}
export function eraseProfile(id){if(!id)return [];const docs=db.prepare('SELECT filename FROM documents WHERE profile_id=?').all(id);db.prepare('DELETE FROM profiles WHERE id=?').run(id);return docs.map(r=>r.filename);}
export function saveDoc(id,filename){const docid=uid();db.prepare('INSERT INTO documents(id,profile_id,filename,created_at) VALUES (?,?,?,?)').run(docid,id,filename,now());return docid;}
export function listDocs(id){return db.prepare('SELECT id,created_at FROM documents WHERE profile_id=? ORDER BY created_at DESC').all(id);}
export function lookupDoc(id,profileId){return db.prepare('SELECT * FROM documents WHERE id=? AND profile_id=?').get(id,profileId);}
export function createSession(role,profileId){const raw=crypto.randomBytes(32).toString('base64url');const hash=crypto.createHash('sha256').update(raw).digest('hex');const expires=new Date(Date.now()+180*24*3600e3).toISOString();db.prepare('INSERT INTO sessions(token_hash,role,profile_id,expires_at) VALUES (?,?,?,?)').run(hash,role,profileId,expires);return raw;}
export function resolveSession(raw){if(!raw)return null;const hash=crypto.createHash('sha256').update(raw).digest('hex');const s=db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hash,now());return s||null;}
export function removeSession(raw){if(raw)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(raw).digest('hex'));}
export function replaceSessionProfile(raw,id){const hash=crypto.createHash('sha256').update(raw).digest('hex');db.prepare('UPDATE sessions SET profile_id=? WHERE token_hash=?').run(id,hash);}
