// Formato ATS en blanco y negro, basado en el modelo elegido.
// La fecha puede estimarse CON la persona; nunca la suponemos sin confirmación.
const value=x=>String(x??'').trim();
const placeholder=/^(?:no s[eé]|ningun[ao]?|nada|no tengo|no corresponde|sin datos?|a[uú]n no|n\/a|desconozco|pendiente|por definir|-+)\.?$/i;
export const filled=x=>Boolean(value(x)&&!placeholder.test(value(x)));
const FIRST_JOB=/^(?:en b[uú]squeda de (?:mi )?primera experiencia laboral|sin experiencia laboral previa(?:,|$))/i;
export const months=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
export function isoMonth(year,month){
 const y=Number(year),m=Number(month);
 return Number.isInteger(y)&&y>=1950&&y<=2100&&Number.isInteger(m)&&m>=1&&m<=12?String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0'):null;
}
export function monthLabel(iso){
 if(iso==='Actualidad')return 'Actualidad';
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(value(iso)))return '';
 const [year,month]=iso.split('-');
 return months[Number(month)-1]+' '+year;
}
const parseJSON=raw=>{try{const j=JSON.parse(value(raw));return j&&typeof j==='object'&&!Array.isArray(j)?j:null}catch{return null}};
const words=raw=>Array.isArray(raw)?raw.map(value).filter(Boolean):value(raw).split(/[\n;]+/).map(x=>x.replace(/^\s*[•*\-]\s*/,'').trim()).filter(Boolean);
export const firstJob=raw=>FIRST_JOB.test(value(raw));
export function experienceEntries(raw){
 const data=parseJSON(raw);
 if(data&&Array.isArray(data.experiencias))return data.experiencias.map(e=>({
  puesto:value(e.puesto),lugar:value(e.lugar),ubicacion:value(e.ubicacion),
  inicio:value(e.inicio),fin:value(e.fin),aproximada:!!e.aproximada,
  actividades:words(e.actividades)
 })).filter(e=>e.puesto||e.lugar||e.inicio||e.actividades.length);
 return [];
}
export function educationEntries(raw){
 const data=parseJSON(raw);
 if(data&&Array.isArray(data.estudios))return data.estudios.map(e=>({
  titulo:value(e.titulo),institucion:value(e.institucion),inicio:value(e.inicio),
  fin:value(e.fin),estado:value(e.estado),aproximada:!!e.aproximada
 })).filter(e=>e.titulo||e.institucion);
 return [];
}
export function validExperience(e){
 if(!filled(e.puesto)||!filled(e.lugar)||!monthLabel(e.inicio)||!monthLabel(e.fin)||!e.actividades?.length)return false;
 if(e.fin!=='Actualidad'&&e.inicio>e.fin)return false;
 return true;
}
export function cvReadiness(fields={}){
 const f=fields||{},missing=[];
 const need=(cond,campo,pregunta)=>{if(!cond)missing.push({campo,pregunta});};
 need(filled(f.nombre),'nombre','¿Cómo es tu nombre?');
 need(filled(f.apellido),'apellido','¿Cuál es tu apellido? Queremos que aparezca tu nombre completo.');
 need(filled(f.telefono)||filled(f.correo),'contacto','¿Tenés un teléfono o correo para que puedan llamarte a una entrevista?');
 need(filled(f.perfil_profesional)||filled(f.objetivo),'perfil_profesional','¿Qué tipo de trabajo te interesa? Te ayudo a escribir una breve presentación.');
 need(filled(f.habilidades),'habilidades','¿Qué cosas sabés hacer? Podemos pensar en tareas de tu día a día.');
 const jobs=experienceEntries(f.experiencia);
 const jobsComplete=jobs.length>0&&jobs.every(validExperience);
 need(firstJob(f.experiencia)||jobsComplete,'experiencia',
  'Vamos a ordenar dónde trabajaste, de qué te encargabas y aproximadamente en qué mes y año comenzaste y terminaste. Podemos usar acontecimientos que recuerdes como referencia.');
 need(filled(f.formacion),'formacion','¿Dónde estudiaste o qué cursos y talleres hiciste?');
 need(filled(f.idiomas),'idiomas','¿Qué idiomas utilizás para comunicarte?');
 return {ok:missing.length===0,faltantes:missing};
}
export function items(raw){
 const v=value(raw);if(!v)return [];
 const data=parseJSON(v);if(data&&Array.isArray(data.items))return words(data.items);
 const rows=v.split(/\n|;/).map(x=>x.replace(/^\s*[•*\-]\s*/,'').trim()).filter(Boolean);
 return rows.length>1?rows:v.split(/;\s*|,\s*(?=\p{L})/u).map(value).filter(Boolean);
}
export function experienceLines(raw){
 return value(raw).replace(/\r/g,'').split('\n').map(value).filter(Boolean);
}
export function cvContent(fields={}){
 const f=fields||{};
 const name=[value(f.nombre),value(f.apellido)].filter(Boolean).join(' ');
 const briefRole=value(f.objetivo);
 const position=briefRole.length<=65&&!/[.!?;]/.test(briefRole)?briefRole:'';
 const city=value(f.localidad);
 const jobs=experienceEntries(f.experiencia).sort((a,b)=>((b.fin==='Actualidad'?'9999-12':b.fin)||'').localeCompare((a.fin==='Actualidad'?'9999-12':a.fin)||'')||b.inicio.localeCompare(a.inicio));
 const studies=educationEntries(f.formacion);
 return {
  name,
  roleLine:[position,city].filter(Boolean).join(city&&position?' - ':''),
  contacts:[value(f.telefono),value(f.correo)].filter(Boolean),
  profile:value(f.perfil_profesional)||value(f.objetivo),
  skills:items(f.habilidades),
  experience:jobs,
  firstExperience:firstJob(f.experiencia),
  education:studies,
  educationLegacy:studies.length?[]:experienceLines(f.formacion),
  languages:items(f.idiomas),
  courses:items(f.cursos),
  others:items(f.otros)
 };
}
export function upsertExperience(existing,entry,replaceIndex=0){
 const fields={
  puesto:value(entry.puesto),lugar:value(entry.lugar),ubicacion:value(entry.ubicacion),
  inicio:isoMonth(entry.inicio_anio,entry.inicio_mes),
  fin:entry.actual===true?'Actualidad':isoMonth(entry.fin_anio,entry.fin_mes),
  aproximada:entry.aproximada===true,actividades:words(entry.actividades)
 };
 const faltantes=[];
 if(!filled(fields.puesto))faltantes.push('puesto o actividad');
 if(!filled(fields.lugar))faltantes.push('empresa, organización o contexto real de trabajo');
 if(!fields.inicio)faltantes.push('mes y año aproximados de inicio');
 if(!fields.fin)faltantes.push('mes y año aproximados de finalización o si continúa');
 if(!fields.actividades.length)faltantes.push('al menos una tarea realizada');
 if(fields.inicio&&fields.fin&&fields.fin!=='Actualidad'&&fields.inicio>fields.fin)faltantes.push('revisar el orden de las fechas');
 if(faltantes.length)return {ok:false,faltantes};
 const list=experienceEntries(existing);
 if(filled(existing)&&!firstJob(existing)&&!list.length&&entry.migracion_confirmada!==true)
  return {ok:false,faltantes:['Existe información anterior en texto libre. Revisala y confirmá con la persona cómo reorganizarla sin perder trabajos.']};
 const index=Number(replaceIndex);
 if(index>0&&index>list.length)return {ok:false,faltantes:['No existe esa experiencia para corregir. Consultá las experiencias guardadas y elegí el número correcto.']};
 if(index>0)list[index-1]=fields;
 else list.push(fields);
 if(list.length>10)return {ok:false,faltantes:['máximo 10 experiencias por CV']};
 return {ok:true,valor:JSON.stringify({experiencias:list}),experiencias:list};
}
export function upsertEducation(existing,entry,replaceIndex=0){
 const data={
  titulo:value(entry.titulo),institucion:value(entry.institucion),
  inicio:isoMonth(entry.inicio_anio,entry.inicio_mes),
  fin:entry.en_curso===true?'Actualidad':isoMonth(entry.fin_anio,entry.fin_mes),
  estado:value(entry.estado),aproximada:entry.aproximada===true
 };
 if(!data.titulo||!data.institucion)return {ok:false,faltantes:['estudio y nombre de institución']};
 if(data.inicio&&data.fin&&data.fin!=='Actualidad'&&data.inicio>data.fin)
  return {ok:false,faltantes:['revisar las fechas de educación']};
 const list=educationEntries(existing);
 if(filled(existing)&&!list.length&&entry.migracion_confirmada!==true)
  return {ok:false,faltantes:['Hay estudios anteriores en texto libre. Consultalos y pedí permiso para reorganizarlos.']};
 const index=Number(replaceIndex);
 if(index>0&&index>list.length)return {ok:false,faltantes:['No existe ese estudio para corregir; consultá los estudios guardados.']};
 if(index>0)list[index-1]=data;
 else list.push(data);
 return {ok:true,valor:JSON.stringify({estudios:list}),estudios:list};
}
