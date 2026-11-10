import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('every operator input has a persistent visible associated label, not only a placeholder', () => {
  for (const match of html.matchAll(/<(?:input|textarea|select)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    assert.match(html, new RegExp(`<label\\b[^>]*\\bfor="${match[1]}"[^>]*>[^<]*\\S`), match[1]);
  }
});

test('instructions, stdout text alternative and contextual result regions exist outside the VM canvas', () => {
  for (const id of ['objectInputHelp', 'jobInputHelp', 'vmCommandHelp', 'pointerScopeHelp', 'providerTokenHelp', 'pointerAdmissionHelp', 'recoverySelectionHelp']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(html, new RegExp(`aria-describedby="[^"]*${id}`), id);
  }
  assert.match(html, /<pre[^>]*id="vmStdoutText"[^>]*tabindex="0"/);
  assert.match(html, /id="vmStdoutSummary"[^>]*role="status"/);
  for (const id of ['mesh', 'objects', 'compute', 'vm', 'pointers', 'resources']) {
    assert.match(html, new RegExp(`id="${id}ActionStatus"[^>]*role="status"`), id);
  }
});
