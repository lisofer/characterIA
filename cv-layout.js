// Datos compartidos por los generadores PDF y Word.
// Un CV completo puede incluir experiencia no remunerada; nunca fabricamos datos.
const value=x=>String(x??'').trim();
const placeholder=/^(?:no s[eé]|ningun[ao]?|nada|no tengo|no corresponde|sin datos?|a[uú]n no|n\/a|desconozco|pendiente|por definir|\-+)\.?$/i;
export const filled=x=>Boolean(value(x)&&!placeholder.test(value(x)));
export function cvReadiness(fields={}){
 const f=fields||{},missing=[];
 const need=(condition,field,prompt)=>{if(!condition)missing.push({campo:field,pregunta:prompt});};
 need(filled(f.nombre),'nombre','¿Cómo es tu nombre?');
 need(filled(f.apellido),'apellido','¿Y tu apellido? Lo necesitamos para que figure completo en el CV.');
 need(filled(f.telefono)||filled(f.correo),'contacto','¿Me compartís un teléfono o un correo? Es la forma en que podrán contactarte para una entrevista. Si tenés ambos, mejor.');
 need(filled(f.perfil_profesional)||filled(f.objetivo),'perfil_profesional','Contame qué tipo de tarea te gustaría hacer o qué se te da bien. Así armamos juntos una presentación breve.');
 need(filled(f.habilidades),'habilidades','¿Qué cosas sabés hacer o suelen reconocerte? Pueden ser habilidades de tu casa, un taller, un grupo o un trabajo.');
 need(filled(f.experiencia),'experiencia','¿Hiciste alguna tarea para alguien, en tu casa, en un proyecto, ayudando a otra persona o en un trabajo? No hace falta que haya sido paga.');
 need(filled(f.formacion),'formacion','¿Hasta qué año estudiaste? También podemos mencionar talleres o cursos que hayas realizado.');
 need(filled(f.idiomas),'idiomas','¿Qué idioma hablás? Por ejemplo, podemos registrar español si me confirmás que es el que utilizás.');
 return {ok:missing.length===0,faltantes:missing};
}
const trimBullet=s=>value(s).replace(/^(?:[•*\-]|\d+[.)])\s*/,'').trim();
export function items(raw){
 const text=value(raw);if(!text)return [];
 const byLines=text.split(/\n/).map(trimBullet).filter(Boolean);
 if(byLines.length>1)return byLines;
 return text.split(/\s*[;•]\s*|,\s*(?=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/).map(trimBullet).filter(Boolean);
}
export function experienceLines(raw){
 // Respetar títulos, lugares, fechas y logros tal como los confirmó la persona.
 return value(raw).replace(/\r/g,'').split('\n').map(s=>s.trim()).filter(Boolean);
}
export function cvContent(fields={}){
 const f=fields||{};
 const name=[value(f.nombre),value(f.apellido)].filter(Boolean).join(' ').toLocaleUpperCase('es-AR');
 const contacts=[value(f.correo),value(f.telefono),value(f.localidad)].filter(Boolean);
 const sections=[
  {type:'text',label:'RESUMEN PROFESIONAL',text:value(f.perfil_profesional)||value(f.objetivo)},
  {type:'skills',label:'APTITUDES',values:items(f.habilidades)},
  {type:'lines',label:'EXPERIENCIA',values:experienceLines(f.experiencia)},
  {type:'lines',label:'FORMACIÓN ACADÉMICA',values:experienceLines(f.formacion)},
  {type:'skills',label:'IDIOMAS',values:items(f.idiomas)}
 ];
 if(filled(f.cursos))sections.push({type:'lines',label:'CURSOS',values:experienceLines(f.cursos)});
 if(filled(f.otros))sections.push({type:'lines',label:'INFORMACIÓN ADICIONAL',values:experienceLines(f.otros)});
 return {name,contacts,sections};
}
