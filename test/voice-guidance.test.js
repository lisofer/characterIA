import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceGuidance} from '../voice-guidance.js';

test('el avatar habla con una sola persona en español argentino',()=>{
 assert.match(voiceGuidance,/una sola persona/i);
 assert.match(voiceGuidance,/contame/);
 assert.match(voiceGuidance,/segunda persona plural/i);
});
test('la introducción se concentra en el currículum, sin desviar la charla',()=>{
 assert.match(voiceGuidance,/Te ayudo a preparar tu currículum/);
 assert.match(voiceGuidance,/almacenamiento/);
 assert.match(voiceGuidance,/trabajo le interesa/);
});
test('el trabajo no se restringe a empresas',()=>{
 assert.match(voiceGuidance,/no reduzcas las posibilidades a empresas/i);
 assert.match(voiceGuidance,/un comercio/);
 assert.match(voiceGuidance,/una casa particular/);
});
test('la conversación enseña, no funciona como formulario',()=>{
 assert.match(voiceGuidance,/una pregunta principal por turno/);
 assert.match(voiceGuidance,/alternala con comentarios genuinos/);
 assert.match(voiceGuidance,/proponé títulos breves/);
});
