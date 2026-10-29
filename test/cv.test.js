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
