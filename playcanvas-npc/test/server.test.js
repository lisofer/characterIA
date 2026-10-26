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
  assert.equal(profiles.data.length, 0, 'No se crea Dante por defecto.');
  // Browser form submits POST/PUT/DELETE with an Origin header. This was
  // previously 403 unless the Railway URL was redundantly in APP_ORIGINS.
  // The integration HTTP server runs on localhost; the origin validation
  // helper separately asserts the real Railway HTTPS hostname.
  const sameOrigin = base;
  const siteHeaders = { ...h, Origin: sameOrigin };
  const preflight = await fetch(base + '/api/admin/npcs', {
    method: 'OPTIONS',
    headers: { Origin: sameOrigin,
      'Access-Control-Request-Method':'POST',
      'Access-Control-Request-Headers':'authorization,content-type' }
  });
  assert.equal(preflight.status, 204, 'Browser preflight allows admin save from its own domain');
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /DELETE/);
  const forbiddenOrigin = await json(base, '/api/admin/npcs', {
    method: 'POST',
    headers: { ...siteHeaders, Origin: 'https://evil.example' },
    body: JSON.stringify({ name:'Intruso',voice:'Kore',prompt:'No.' })
  });
  assert.equal(forbiddenOrigin.status, 403, 'Do not allow other origins');
  const wrongCreate = await json(base, '/api/admin/npcs', {
    method: 'POST', body: JSON.stringify({ name: 'Hacker', voice: 'Kore', prompt: 'No autorizado' }),
    headers: { 'Content-Type': 'application/json' }
  });
  assert.equal(wrongCreate.status, 401);
  const invalidCreate = await json(base, '/api/admin/npcs', {
    method: 'POST', headers: h, body: JSON.stringify({ name:'Nira', voice:'Kore', prompt:'' })
  });
  assert.equal(invalidCreate.status, 400);
  const created = await json(base, '/api/admin/npcs', {
    method: 'POST', headers: siteHeaders,
    body: JSON.stringify({
      name:'Nira', voice:'Kore', prompt:'Sos una mujer IA en un mundo digital.'
    })
  });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.match(id, /^npc_[0-9a-f]{20}$/);
  const rename = await json(base, '/api/admin/npcs/'+id, {
    method:'PUT', headers:siteHeaders,
    body: JSON.stringify({ name:'EVA', voice:'Kore', prompt:'Una nueva historia.' })
  });
  assert.equal(rename.status, 200);
  assert.equal(rename.data.name, 'EVA');
  const publicProfiles = await json(base, '/api/public/npcs');
  assert.equal(publicProfiles.data.find(p => p.id === id).name, 'EVA');
  assert.equal('prompt' in publicProfiles.data[0], false, 'El prompt privado no debe filtrarse.');
  const s = await json(base, '/api/session', {
    method: 'POST',
    headers: { Origin: 'https://launch.playcanvas.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ npcId: 'auto', playerId: 'player1' })
  });
  assert.equal(s.status, 503, 'Falta Gemini pero el perfil existe.');
  const reset = await json(base, '/api/admin/reset/' + id + '/player1', { method: 'POST', headers: h });
  assert.equal(reset.status, 200);
  const memory = await json(base, '/api/admin/memory/' + id + '/player1', { headers: h });
  assert.equal(memory.data.turns.length, 0);
  const deleted = await json(base, '/api/admin/npcs/' + id, { method: 'DELETE', headers: siteHeaders });
  assert.equal(deleted.status, 200);
  const after = await json(base, '/api/admin/npcs', { headers: h });
  assert.deepEqual(after.data, []);
  const nonexistent = await json(base, '/api/admin/memory/' + id + '/player1', { headers: h });
  assert.equal(nonexistent.status, 404);
});
