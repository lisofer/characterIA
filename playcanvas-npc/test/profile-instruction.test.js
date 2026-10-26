import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNpcInstruction } from '../profile-instruction.js';

test('la identidad editable se impone al identificador o al nombre viejo del prompt', () => {
  const prompt = 'Sos Dante, un contrabandista; te gusta bromear.';
  const instruction = buildNpcInstruction({
    id: 'dante',
    name: 'Nira',
    voice: 'Kore',
    prompt
  }, { summary: 'El jugador trajo una flor.', turns: [{ role:'user', text:'Hola' }] });
  assert.match(instruction, /Tu nombre actual es "Nira"/);
  assert.match(instruction, /El nombre anterior o identificador tecnico del NPC no es tu nombre/);
  assert.match(instruction, /te gusta bromear/);
  assert.match(instruction, /El jugador trajo una flor/);
  assert.ok(instruction.lastIndexOf('Nira') > instruction.lastIndexOf('Sos Dante'));
});

test('la personalidad se actualiza sin perder la memoria persistente incluida', () => {
  const profile={ id:'dante',name:'EVA',prompt:'Sos una inteligencia artificial creada en una ciudad digital.' };
  const memory={ summary:'El jugador confía en vos.', turns:[] };
  const result=buildNpcInstruction(profile,memory);
  assert.match(result,/Tu nombre actual es "EVA"/);
  assert.match(result,/Sos una inteligencia artificial/);
  assert.match(result,/El jugador confía en vos/);
});

test('se entrega toda una personalidad extensa a Gemini, sin el antiguo corte de 6000 caracteres', () => {
  const prompt = 'Nira es dulce, aventurera y desea ser una persona de verdad. '.repeat(180);
  assert.ok(prompt.length > 6000);
  const instruction = buildNpcInstruction({ id: 'nira', name: 'Nira', voice: 'Kore', prompt }, { summary:'', turns:[] });
  assert.ok(instruction.includes(prompt), 'Gemini debe recibir el prompt completo');
  assert.ok(instruction.length > 6000);
});
