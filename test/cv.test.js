import test from 'node:test';
import assert from 'node:assert/strict';
import {cvReadiness,cvContent,upsertExperience,upsertEducation,monthLabel,experienceEntries} from '../cv-layout.js';

const profile={
 nombre:'Olivia',apellido:'Wilson',telefono:'316 212 3456',
 objetivo:'Diseñadora gráfica',localidad:'Medellín, Colombia',
 perfil_profesional:'Diseñadora gráfica con experiencia en proyectos propios.',
 habilidades:'Diseño digital; Organización de proyectos',
 formacion:'Diseño gráfico, estudios realizados en una institución confirmada',
 idiomas:'Español'
};
const job={
 puesto:'Diseñadora gráfica',lugar:'Estudio Creativo',ubicacion:'Medellín',
 inicio_mes:1,inicio_anio:2023,fin_mes:10,fin_anio:2025,actual:false,
 actividades:'Diseño de materiales; Atención a clientes',
 aproximada:true
};

test('experiencia requiere puesto, lugar, fecha completa y tareas',()=>{
 assert.deepEqual(upsertExperience('',{...job,lugar:''}).faltantes.includes('empresa, organización o contexto real de trabajo'),true);
 assert.equal(upsertExperience('',{...job,inicio_mes:null}).ok,false);
 assert.equal(upsertExperience('',{...job,actividades:''}).ok,false);
 assert.equal(upsertExperience('',{...job,fin_mes:1,fin_anio:2022}).ok,false);
 assert.equal(upsertExperience('',job).ok,true);
});
test('fechas confirmadas se muestran con mes y año',()=>{
 assert.equal(monthLabel('2023-01'),'Enero 2023');
 assert.equal(monthLabel('2025-10'),'Octubre 2025');
 assert.equal(monthLabel('2025'),'');
 assert.equal(monthLabel('Actualidad'),'Actualidad');
});
test('el CV exige nombre, apellido y uno de dos contactos',()=>{
 const saved=upsertExperience('',job).valor;
 assert.equal(cvReadiness({...profile,experiencia:saved}).ok,true);
 assert.equal(cvReadiness({...profile,apellido:'',experiencia:saved}).ok,false);
 assert.equal(cvReadiness({...profile,correo:'',telefono:'',experiencia:saved}).ok,false);
});
test('experiencia anterior en texto libre no se sobrescribe sin confirmar migración',()=>{
 assert.equal(upsertExperience('Trabajé en un almacén',job).ok,false);
 assert.equal(upsertExperience('Trabajé en un almacén',{...job,migracion_confirmada:true}).ok,true);
});
test('puede registrar primera experiencia sin inventar empresas',()=>{
 assert.equal(cvReadiness({...profile,experiencia:'En búsqueda de primera experiencia laboral'}).ok,true);
});
test('experiencias nuevas primero, mantiene fechas y viñetas',()=>{
 const first=upsertExperience('',{...job,puesto:'Anterior',fin_anio:2020,inicio_anio:2019});
 const second=upsertExperience(first.valor,{...job,puesto:'Reciente'});
 assert.deepEqual(cvContent({...profile,experiencia:second.valor}).experience.map(x=>x.puesto),['Reciente','Anterior']);
 assert.deepEqual(experienceEntries(second.valor)[0].actividades,['Diseño de materiales','Atención a clientes']);
});
test('reemplazar un trabajo modifica el mismo registro, no duplica',()=>{
 const first=upsertExperience('',job);
 const edited=upsertExperience(first.valor,{...job,puesto:'Coordinadora'},1);
 assert.equal(experienceEntries(edited.valor).length,1);
 assert.equal(experienceEntries(edited.valor)[0].puesto,'Coordinadora');
 assert.equal(upsertExperience(first.valor,{...job,puesto:'Otro'},5).ok,false);
});
test('educación conserva institución y puede guardar meses confirmados',()=>{
 const record=upsertEducation('',{titulo:'Técnica gráfica',institucion:'Escuela de Arte',inicio_mes:3,inicio_anio:2019,fin_mes:12,fin_anio:2022,estado:'Finalizado'});
 assert.equal(record.ok,true);
 assert.equal(cvContent({...profile,formacion:record.valor}).education[0].institucion,'Escuela de Arte');
});

test('localidad es obligatoria, los idiomas no',()=>{
 const work=upsertExperience('',job);
 const fields={...profile,experiencia:work.valor};
 assert.equal(cvReadiness(fields).ok,true);
 assert.equal(cvReadiness({...fields,localidad:''}).ok,false);
 assert.equal(cvReadiness({...fields,idiomas:''}).ok,true);
});
test('cabecera breve con etiquetas explícitas y barras verticales',()=>{
 const work=upsertExperience('',job);
 const cv=cvContent({...profile,correo:'persona@example.com',experiencia:work.valor});
 assert.deepEqual(cv.contactParts,['Tel: 316 212 3456','Correo: persona@example.com','Ubicación: Medellín, Colombia']);
 assert.equal(cv.contactParts.join(' | ').includes(' | '),true);
});
test('el resumen de una hoja limita aptitudes, trabajos y tareas sin modificar lo guardado',()=>{
 let record='';
 for(let i=0;i<4;i++)record=upsertExperience(record,{...job,puesto:'Puesto '+i}).valor;
 const cv=cvContent({...profile,habilidades:'Uno; Dos; Tres; Cuatro; Cinco; Seis',experiencia:record});
 assert.equal(cv.experience.length,3);
 assert.equal(cv.skills.length,4);
 assert.equal(experienceEntries(record).length,4);
});

test('el asistente sugiere títulos profesionales antes de guardar frases coloquiales',()=>{
 const original={...job,puesto:'fui ayudante de un panadero',actividades:'llevar comida'};
 const pending=upsertExperience('',original);
 assert.equal(pending.ok,false);
 assert.equal(pending.requiere_redaccion,true);
 assert.equal(pending.sugerencia_puesto,'Auxiliar de panadería');
 assert.deepEqual(pending.sugerencias_tareas,['Entrega de pedidos de comida a domicilio']);
 const approved=upsertExperience('',{...original,puesto:'Auxiliar de panadería',actividades:'Colaboración en la elaboración de productos de panadería',redaccion_profesional_aprobada:true});
 assert.equal(approved.ok,true);
});
test('una única experiencia puede incluir hasta tres tareas confirmadas',()=>{
 const entry=upsertExperience('',{...job,actividades:'Tarea 1; Tarea 2; Tarea 3; Tarea 4'});
 assert.equal(entry.ok,true);
 assert.equal(cvContent({...profile,experiencia:entry.valor}).experience[0].actividades.length,3);
});

test('nombre completo no se duplica en CV ni obliga a preguntar apellido otra vez',()=>{
 const source={...profile,nombre:'Lisandro Fernández',apellido:'Fernández',
  experiencia:'En búsqueda de primera experiencia laboral'};
 assert.equal(cvReadiness(source).ok,true);
 assert.equal(cvContent(source).name,'Lisandro Fernández');
 assert.equal(cvContent({...source,apellido:''}).name,'Lisandro Fernández');
});
