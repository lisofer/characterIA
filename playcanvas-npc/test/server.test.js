import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

async function freePort() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));
  return port;
}
async function json(base, route, opts = {}) {
  const r = await fetch(base + route, opts);
  return { status: r.status, data: await r.json() };
}
test('arranca sin API key, protege panel y mantiene datos en disco', { timeout: 14000 }, async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'npc-http-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(''),
    env: {
      ...process.env, PORT: String(port),
      GEMINI_API_KEY: '', ADMIN_TOKEN: 'test-only-secret',
      APP_ORIGINS: 'https://launch.playcanvas.com',
      DATA_FILE: path.join(tmp, 'data.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    child.kill();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  let output = '';
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  for (let i = 0; i < 70; i++) {
    if (child.exitCode !== null) throw Error('server crashed: ' + output);
    try {
      const r = await json(base, '/api/health');
      if (r.status === 200) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, output || 'health failed');
  const denied = await json(base, '/api/admin/npcs');
  assert.equal(denied.status, 401);
  const h = { Authorization: 'Bearer test-only-secret', 'Content-Type': 'application/json' };
  const profiles = await json(base, '/api/admin/npcs', { headers: h });
  assert.equal(profiles.status, 200);
  assert.equal(profiles.data[0].id, 'dante');
  const rename = await json(base, '/api/admin/npcs/dante', {
    method: 'PUT', headers: h,
    body: JSON.stringify({
      name: 'Nira', voice: 'Kore',
      prompt: 'Sos una inteligencia artificial curiosa que vive en una ciudad digital.'
    })
  });
  assert.equal(rename.status, 200);
  assert.equal(rename.data.name, 'Nira');
  const publicProfiles = await json(base, '/api/public/npcs');
  assert.equal(publicProfiles.data.find(p => p.id === 'dante').name, 'Nira');
  assert.equal('prompt' in publicProfiles.data[0], false, 'El prompt privado no debe filtrarse a PlayCanvas');
  const s = await json(base, '/api/session', {
    method: 'POST',
    headers: { Origin: 'https://launch.playcanvas.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ npcId: 'dante', playerId: 'player1' })
  });
  assert.equal(s.status, 503);
  const reset = await json(base, '/api/admin/reset/dante/player1', { method: 'POST', headers: h });
  assert.equal(reset.status, 200);
  const memory = await json(base, '/api/admin/memory/dante/player1', { headers: h });
  assert.equal(memory.data.turns.length, 0);
});
