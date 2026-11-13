import test from 'node:test';
import assert from 'node:assert/strict';
import { guestShellReady } from '../vendor/guest/qualification-protocol.mjs';
test('waits for an actual line-start root shell prompt, not kernel banner bytes', () => {
  for (const text of ['Linux version 6.18.7 #', 'Linux version 6.18.7 #1', 'kernel # ', '\n#', '\nlog # ']) {
    assert.equal(guestShellReady(text), false, text);
  }
  for (const text of ['# ', '\r\n# ', '\n/ # ', '\n/tmp # ']) {
    assert.equal(guestShellReady(text), true, text);
  }
});
