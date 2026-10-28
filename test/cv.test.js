import test from 'node:test';
import assert from 'node:assert/strict';
import {cvReadiness,cvContent,items} from '../cv-layout.js';

const complete={
 nombre:'Georgina',apellido:'López Millán',correo:'georgina.lopez@gmail.com',
 perfil_profesional:'Experiencia en atención al cliente',
 habilidades:'Manejo de caja; Atención al cliente; Trabajo en equipo',
 experiencia:'Atención en restaurantes',
 formacion:'Tecnicatura en restauración',idiomas:'Español'
};

test('nombre y apellido son obligatorios y se almacenan por separado',()=>{
 const missing=cvReadiness({...complete,apellido:''});
 assert.equal(missing.ok,false);
 assert.ok(missing.faltantes.some(x=>x.campo==='apellido'));
});

test('un contacto alcanza; ninguno bloquea la descarga',()=>{
 assert.equal(cvReadiness({...complete,telefono:'',correo:''}).ok,false);
 assert.equal(cvReadiness({...complete,telefono:'1166667777',correo:''}).ok,true);
 assert.equal(cvReadiness({...complete,telefono:'',correo:'test@example.com'}).ok,true);
});

test('todos los cinco apartados deben estar presentes y ser significativos',()=>{
 const fields={...complete,experiencia:'No tengo',habilidades:'No sé'};
 const missing=cvReadiness(fields).faltantes.map(x=>x.campo);
 assert.deepEqual(missing.sort(),['experiencia','habilidades'].sort());
});

test('permite primera experiencia realista, sin atribuir trabajo no confirmado',()=>{
 assert.equal(cvReadiness({...complete,experiencia:'En búsqueda de primera experiencia laboral'}).ok,true);
});

test('el formato tiene los cinco apartados y habilidades en lista',()=>{
 const cv=cvContent(complete);
 assert.equal(cv.name,'GEORGINA LÓPEZ MILLÁN');
 assert.deepEqual(cv.sections.map(x=>x.label),[
 'RESUMEN PROFESIONAL','APTITUDES','EXPERIENCIA','FORMACIÓN ACADÉMICA','IDIOMAS'
 ]);
 assert.equal(items(complete.habilidades).length,3);
});
