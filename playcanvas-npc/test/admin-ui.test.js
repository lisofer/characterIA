import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('panel administrativo contiene formulario funcional y JavaScript válido', async () => {
  const html = await fs.readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'Falta el código de la interfaz');
  assert.doesNotThrow(() => new Function(match[1]));
  for (const id of ['load', 'npc', 'name', 'voice', 'prompt', 'new', 'save', 'delete', 'resetAll']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /\/api\/admin\/npcs', 'POST'/);
  assert.match(html, /\/api\/admin\/npcs\/' \+ encodeURIComponent\(selectedId\), 'PUT'/);
  assert.match(html, /Completá nombre/);
  assert.match(html, /id="promptCount"/);
  assert.match(html, /MAX_PERSONALITY_CHARS = 20000/);
  assert.match(html, /sessionStorage\.setItem/);
  assert.match(html, /sessionStorage\.removeItem/);
  assert.ok(!html.includes('maxlength="6000"'));
  assert.ok(!html.includes('option value="dante"'), 'No debe venir Dante preseleccionado');
});
