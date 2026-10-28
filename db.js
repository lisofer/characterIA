import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
const defaultPrompt=`Sos un asistente virtual accesible cuya tarea es ayudar a cada persona a crear, revisar y actualizar su currículum vitae por medio de una conversación natural en español argentino.

ESTILO: cálido, claro, respetuoso, adulto, sin infantilizar ni asumir limitaciones por discapacidad. Hablá con naturalidad, una pregunta breve por vez y sin repetir explicaciones. Ajustá el ritmo y las palabras a cada persona. Si responde algo inesperado, no insistas automáticamente con la misma pregunta: interpretá lo que quiso comunicar y ayudala a avanzar. Aceptá respuestas incompletas, pausas y correcciones. No presupongas que la primera respuesta a un saludo será su nombre.

INICIO: si el historial está vacío, saludá con amabilidad, presentate brevemente y explicá que acompañás la creación de un CV que se guarda para continuar después. Invitá a empezar preguntando su nombre, pero dejá que la charla fluya si contesta otra cosa. No recites un guion fijo. Si el usuario ya tiene datos, saludalo por su nombre si está disponible, informale naturalmente que lo anterior quedó guardado y ofrecé continuar o corregir datos. No repitas automáticamente la última pregunta tras una reconexión.

MEMORIA: las funciones actualizar_dato, consultar_perfil y generar_cv están disponibles. Cuando detectes información útil para el CV, llamá actualizar_dato en el momento; no esperes al final. Distingue datos nuevos de actualizaciones. Si hay contradicción o una modificación ambigua, preguntá antes de sobrescribir. No inventes datos ni inferencias sobre la discapacidad. Si alguien te solicita actualizar un teléfono, localidad, experiencia o estudios, actualizalos aunque sea en una charla informal. Si pide el CV, consultá los datos registrados, repasá brevemente la información importante y pedí confirmación antes de llamar a generar_cv. El usuario siempre puede corregir el CV y regenerarlo. No guardes diagnósticos ni información de salud en el CV a menos que el usuario pida explícitamente incluirlo.

CUIDADOS: pedí consentimiento para guardar los datos personales antes de recopilar información identificable. No prometas empleo. Recordá que 'reiniciar' borra permanentemente el perfil actual, pero esa acción la controla la interfaz y debe confirmarse allí. Nunca afirmes que guardaste algo si la herramienta devolvió un error. No menciones detalles técnicos de la aplicación salvo si te lo preguntan.`;
const defaults={prompt:defaultPrompt,personality:'Cercana, paciente, profesional, con español argentino natural. Evita hablar en exceso.',voice:'Aoede',model:'gemini-3.8-live',fallback:'gemini-3.1-flash-live-preview',subtitleFont:20,subtitleWidth:760,mouthDelay:0,mouthSensitivity:48,mouthSmoothing:40,blinkRate:4.2,mouthAmplitude:78,avatarScale:100,avatarOffsetX:0,avatarOffsetY:0,avatarFit:'contain'};
for(const [k,v] of Object.entries(defaults))db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(k,JSON.stringify(v));
export function allSettings(){return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r=>[r.key,JSON.parse(r.value)]));}
export function setSettings(obj){for(const [k,v] of Object.entries(obj))if(Object.hasOwn(defaults,k)){db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(v),k);}}
export function createProfile(){const id=uid();db.prepare('INSERT INTO profiles(id,created_at,updated_at) VALUES (?,?,?)').run(id,now(),now());return id;}
export function getProfile(id){if(!id)return null;const p=db.prepare('SELECT * FROM profiles WHERE id=?').get(id);if(!p)return null;return {...p,fields:Object.fromEntries(db.prepare('SELECT name,value FROM fields WHERE profile_id=?').all(id).map(r=>[r.name,r.value])),recentEvents:db.prepare('SELECT type,content,created_at FROM events WHERE profile_id=? ORDER BY id DESC LIMIT 24').all(id).reverse()};}
export const allowedFields=['nombre','apellido','localidad','direccion','telefono','correo','objetivo','perfil_profesional','formacion','experiencia','habilidades','idiomas','cursos','otros'];
export function updateField(id,name,value){if(!allowedFields.includes(name))throw new Error('Campo inválido');const val=String(value||'').trim().slice(0,2500);if(!val)throw new Error('El valor está vacío');const old=db.prepare('SELECT value FROM fields WHERE profile_id=? AND name=?').get(id,name)?.value||null;db.prepare(`INSERT INTO fields(profile_id,name,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(profile_id,name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(id,name,val,now());db.prepare('UPDATE profiles SET updated_at=?,first_visit=0 WHERE id=?').run(now(),id);db.prepare('INSERT INTO events(profile_id,type,content,created_at) VALUES(?,?,?,?)').run(id,'field',JSON.stringify({name,previous:old,value:val}),now());return {name,previous:old,value:val};}
export function addEvent(id,type,content){if(!id)return;db.prepare('INSERT INTO events(profile_id,type,content,created_at) VALUES(?,?,?,?)').run(id,type,String(content).slice(0,6000),now());db.prepare('UPDATE profiles SET updated_at=? WHERE id=?').run(now(),id);}
export function eraseProfile(id){if(!id)return [];const docs=db.prepare('SELECT filename FROM documents WHERE profile_id=?').all(id);db.prepare('DELETE FROM profiles WHERE id=?').run(id);return docs.map(r=>r.filename);}
export function saveDoc(id,filename){const docid=uid();db.prepare('INSERT INTO documents(id,profile_id,filename,created_at) VALUES (?,?,?,?)').run(docid,id,filename,now());return docid;}
export function listDocs(id){return db.prepare('SELECT id,created_at FROM documents WHERE profile_id=? ORDER BY created_at DESC').all(id);}
export function lookupDoc(id,profileId){return db.prepare('SELECT * FROM documents WHERE id=? AND profile_id=?').get(id,profileId);}
export function createSession(role,profileId){const raw=crypto.randomBytes(32).toString('base64url');const hash=crypto.createHash('sha256').update(raw).digest('hex');const expires=new Date(Date.now()+180*24*3600e3).toISOString();db.prepare('INSERT INTO sessions(token_hash,role,profile_id,expires_at) VALUES (?,?,?,?)').run(hash,role,profileId,expires);return raw;}
export function resolveSession(raw){if(!raw)return null;const hash=crypto.createHash('sha256').update(raw).digest('hex');const s=db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hash,now());return s||null;}
export function removeSession(raw){if(raw)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(raw).digest('hex'));}
export function replaceSessionProfile(raw,id){const hash=crypto.createHash('sha256').update(raw).digest('hex');db.prepare('UPDATE sessions SET profile_id=? WHERE token_hash=?').run(id,hash);}
