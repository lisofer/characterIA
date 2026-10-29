import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizedIdentity,splitSimpleFullName} from '../identity.js';
test('Lisandro Fernández se divide sin duplicar',()=>{
 assert.deepEqual(splitSimpleFullName('Lisandro Fernández'),{nombre:'Lisandro',apellido:'Fernández'});
 assert.equal(normalizedIdentity({nombre:'Lisandro Fernández',apellido:'Fernández'}).nombreCompleto,'Lisandro Fernández');
});
test('apellidos compuestos permanecen unidos',()=>{
 assert.equal(normalizedIdentity({nombre:'Georgina',apellido:'López Millán'}).nombreCompleto,'Georgina López Millán');
});
test('ante varios nombres, solicita confirmar la separación',()=>{
 assert.equal(splitSimpleFullName('Juan Carlos Pérez'),null);
});
