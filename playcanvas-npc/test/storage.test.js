import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryStore } from '../storage.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'npc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'memory.json');
  return { s: await new MemoryStore(filename).init(), filename };
}
const nira = { name: 'Nira', voice: 'Kore', prompt: 'Sos Nira, una IA del mundo digital.' };

test('una instalación nueva NO crea automáticamente a Dante', async t => {
  const { s } = await fixture(t);
  assert.deepEqual(await s.getProfiles(), []);
});

test('crear Nira, editarla y persistir después de reiniciar la app', async t => {
  const { s, filename } = await fixture(t);
  const profile = await s.createProfile(nira);
  assert.match(profile.id, /^npc_[0-9a-f]{20}$/);
  assert.equal((await s.getProfile(profile.id)).name, 'Nira');
  await s.saveProfile(profile.id, { ...nira, name: 'EVA', prompt: 'Nueva personalidad' });
  const restarted = await new MemoryStore(filename).init();
  assert.equal((await restarted.getProfile(profile.id)).prompt, 'Nueva personalidad');
  assert.equal((await restarted.getProfile(profile.id)).name, 'EVA');
});

test('reiniciar recuerdos no cambia la personalidad ni la memoria de otro jugador', async t => {
  const { s, filename } = await fixture(t);
  const p = await s.createProfile(nira);
  await s.appendTurn(p.id, 'jugador1', 'user', 'Me llamo Alex');
  await s.appendTurn(p.id, 'jugador1', 'npc', 'Hola Alex');
  await s.appendTurn(p.id, 'jugador2', 'user', 'Soy Cris');
  const version = (await s.getMemory(p.id, 'jugador1')).version;
  const profileBefore = await s.getProfile(p.id);
  await s.reset(p.id, 'jugador1');
  assert.equal((await s.getMemory(p.id, 'jugador1')).turns.length, 0);
  assert.equal((await s.getMemory(p.id, 'jugador1')).version, version+1);
  assert.equal((await s.getMemory(p.id, 'jugador2')).turns.length, 1);
  assert.deepEqual(await s.getProfile(p.id), profileBefore);
  const restarted = await new MemoryStore(filename).init();
  assert.equal((await restarted.getMemory(p.id, 'jugador1')).turns.length, 0);
});

test('resúmenes demorados no reviven recuerdos después del reset', async t => {
  const { s } = await fixture(t);
  const p = await s.createProfile(nira);
  await s.appendTurn(p.id, 'jugador1', 'user', 'Soy Ana');
  const version = (await s.getMemory(p.id, 'jugador1')).version;
  await s.reset(p.id, 'jugador1');
  assert.equal(await s.saveSummaryIfVersion(p.id, 'jugador1', version, 'Recorda Ana'), false);
});

test('eliminar un personaje borra recuerdos asociados e impide crear memorias huérfanas', async t => {
  const { s, filename } = await fixture(t);
  const p = await s.createProfile(nira);
  await s.appendTurn(p.id, 'jugador1', 'user', 'Hola');
  assert.equal(await s.deleteProfile(p.id), true);
  assert.equal(await s.getProfile(p.id), null);
  assert.deepEqual((await s.getMemory(p.id, 'jugador1')).turns, []);
  await s.appendTurn(p.id, 'jugador1', 'npc', 'No debe persistir');
  assert.deepEqual((await s.getMemory(p.id, 'jugador1')).turns, []);
  const restarted = await new MemoryStore(filename).init();
  assert.deepEqual(await restarted.getProfiles(), []);
});

test('no elimina perfiles antiguos que ya estaban guardados en /data', async t => {
  const { s, filename } = await fixture(t);
  await fs.writeFile(filename, JSON.stringify({
    profiles: { dante: { id:'dante', name:'Nombre antiguo', voice:'Kore', prompt:'Personalidad antigua' } },
    memories: {}
  }));
  const reopened = await new MemoryStore(filename).init();
  assert.equal((await reopened.getProfile('dante')).name, 'Nombre antiguo');
  assert.equal((await reopened.getProfiles()).length, 1);
});
