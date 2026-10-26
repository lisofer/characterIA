import test from 'node:test';
import assert from 'node:assert/strict';
import { originAllowed } from '../origin.js';

const allowed = new Set(['https://launch.playcanvas.com', 'https://playcanv.as']);

test('Railway same-origin admin is allowed even when APP_ORIGINS omits the service domain', () => {
  assert.equal(originAllowed(
    'https://chesscut-studio.up.railway.app',
    'chesscut-studio.up.railway.app', allowed
  ), true);
  assert.equal(originAllowed('https://my-service.up.railway.app',
    'my-service.up.railway.app', new Set()), true);
});

test('localhost works for automated tests and local development', () => {
  assert.equal(originAllowed('http://127.0.0.1:3000', '127.0.0.1:3000', allowed), true);
  assert.equal(originAllowed('http://localhost:3000', 'localhost:3000', allowed), true);
});

test('configured PlayCanvas domains work cross-origin', () => {
  assert.equal(originAllowed('https://launch.playcanvas.com', 'chesscut-studio.up.railway.app', allowed), true);
});

test('malicious and malformed origins are rejected', () => {
  for (const origin of [
    'https://evil.example', 'https://chesscut-studio.up.railway.app.attacker.tld',
    'http://chesscut-studio.up.railway.app', 'null',
    'https://chesscut-studio.up.railway.app:1234', 'https://chesscut-studio.up.railway.app/',
    'javascript:alert(1)', 'https://evil.example@other.example'
  ]) {
    assert.equal(originAllowed(origin, 'chesscut-studio.up.railway.app', allowed), false, origin);
  }
});
