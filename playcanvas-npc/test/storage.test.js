import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryStore } from '../storage.js';

test('personalidad guardada sobrevive reinicio del servidor', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'npc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'memory.json');
  let s = await new MemoryStore(db).init();
  await s.saveProfile('dante', { name: 'Dante', voice: 'Kore', prompt: 'Sos un comerciante' });
  s = await new MemoryStore(db).init();
  assert.equal((await s.getProfile('dante')).prompt, 'Sos un comerciante');
});

test('recuerdos persisten, pero reset no borra personalidad', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'npc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'memory.json');
  const s = await new MemoryStore(file).init();
  const before = await s.getProfile('dante');
  await s.appendTurn('dante', 'player1', 'user', 'Me llamo Alex');
  await s.appendTurn('dante', 'player1', 'npc', 'Hola Alex');
  assert.equal((await s.getMemory('dante', 'player1')).turns.length, 2);
  const version = (await s.getMemory('dante', 'player1')).version;
  await s.reset('dante', 'player1');
  const after = await s.getMemory('dante', 'player1');
  assert.equal(after.turns.length, 0);
  assert.equal(after.summary, '');
  assert.equal(after.version, version + 1);
  assert.deepEqual(await s.getProfile('dante'), before);
  const restarted = await new MemoryStore(file).init();
  assert.equal((await restarted.getMemory('dante', 'player1')).turns.length, 0);
});

test('resumen atrasado no puede revivir la memoria', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'npc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const s = await new MemoryStore(path.join(dir, 'save.json')).init();
  await s.appendTurn('dante', 'player1', 'user', 'Mi nombre es Ana');
  const version = (await s.getMemory('dante', 'player1')).version;
  await s.reset('dante', 'player1');
  const saved = await s.saveSummaryIfVersion('dante', 'player1', version, 'Recorda Ana');
  assert.equal(saved, false);
  assert.equal((await s.getMemory('dante', 'player1')).summary, '');
});

test('cada jugador conserva memoria independiente', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'npc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const s = await new MemoryStore(path.join(dir, 'save.json')).init();
  await s.appendTurn('dante', 'player1', 'user', 'Uno');
  await s.appendTurn('dante', 'player2', 'user', 'Dos');
  await s.reset('dante', 'player1');
  assert.equal((await s.getMemory('dante', 'player2')).turns[0].text, 'Dos');
});
