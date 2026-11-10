import test from 'node:test';
import assert from 'node:assert/strict';
import { model } from '../src/layer1-uor/generated-model.js';
const call = (name, ...args) => model[`Stitch.VmAdministration.${name}`](...args);
test('source-derived VM admission predicates match independent finite grant and lifecycle oracles', () => {
  for (let mask = 0; mask < 64; mask++) {
    const [grant, ready, current, open, valid, blocked] = Array.from({ length: 6 }, (_, i) => !!(mask & (1 << i)));
    assert.equal(call('ethernetAllowed', grant, ready, current, open, valid, blocked), grant && ready && current && open && valid && !blocked);
    assert.equal(call('shareAllowed', grant, current, blocked), grant && current && !blocked);
    assert.equal(call('commandAllowed', ready, current, blocked, valid), ready && !current && !blocked && valid);
    assert.equal(call('administrationAllowed', ready, blocked), ready && !blocked);
    assert.equal(call('forgetAllowed', ready, valid, blocked), ready && valid && !blocked);
    for (const generation of [0, 1, 2]) for (const captured of [0, 1, 2]) {
      assert.equal(call('observationAllowed', generation, captured, current, ready, blocked), generation === captured && current && ready && !blocked);
    }
  }
});
