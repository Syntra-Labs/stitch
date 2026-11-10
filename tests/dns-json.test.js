import test from 'node:test';
import assert from 'node:assert/strict';
import { DohResolver, parseSrvRecord } from '../src/layer5-transport/index.js';
const answer = (change = {}) => ({ name: 'wanted.example.', type: 16, TTL: 0, data: 'v=uor1;peer=peer', ...change });
const resolve = body => new DohResolver({ format: "json", fetchImpl: async () => Response.json(body) }).resolve('wanted.example', 'TXT');
test('SRV parsing rejects extra fields, non-UInt16 fields and invalid target names; root means unavailable', () => {
  for (const value of ['-1 NaN 70000 target ignored', '-1 1 443 target', '1 65536 443 target', '1 1 65536 target', '1.5 1 443 target', '1 1 443 target extra', '1 1 443 bad..target', '1 1 443 _not-a-host.example', null]) assert.equal(parseSrvRecord(value), null, String(value));
  assert.deepEqual(parseSrvRecord('0 65535 65535 TARGET.Example.'), { priority: 0, weight: 65535, port: 65535, target: 'target.example' });
  assert.deepEqual(parseSrvRecord('0 0 0 .'), { priority: 0, weight: 0, port: 0, target: '.' });
});
test('provider JSON refuses NXDOMAIN, malformed status, truncation, unrelated owner/type and malformed TTL/class', async () => {
  for (const Status of [undefined, -1, 3, '0', NaN]) await assert.rejects(resolve({ Status, Answer: [answer()] }));
  for (const change of [{ name: 'wrong.example' }, { type: 1 }, { type: '16' }, { TTL: -1 }, { TTL: 0.5 }, { TTL: 2147483648 }, { TTL: undefined }, { class: 3 }, { data: null }]) await assert.rejects(resolve({ Status: 0, Answer: [answer(change)] }), JSON.stringify(change));
  for (const TC of [true, 'true', 1, null]) await assert.rejects(resolve({ Status: 0, TC, Answer: [answer()] }));
  assert.equal((await resolve({ Status: 0, TC: false, Answer: [answer()] })).records.length, 1);
  await assert.rejects(resolve({ Status: 0, Question: [{ name: 'other.example', type: 16 }], Answer: [answer()] }));
});
test('JSON association accepts case/trailing-dot equivalence, zero TTL and one explicit CNAME chain', async () => {
  const direct = await resolve({ Status: 0, Question: [{ name: 'WANTED.EXAMPLE.', type: 16 }], Answer: [answer({ name: 'WANTED.EXAMPLE' })] });
  assert.equal(direct.ttl_seconds, 0); assert.equal(direct.records[0].peer, 'peer');
  const aliased = await resolve({ Status: 0, Answer: [answer({ type: 5, TTL: 5, data: 'target.example.' }), answer({ name: 'target.example.', TTL: 30 })] });
  assert.equal(aliased.ttl_seconds, 5); assert.equal(aliased.records[0].peer, 'peer');
  for (const answers of [
    [answer({ type: 5, data: 'wanted.example.' })],
    [answer({ type: 5, data: 'target.example' }), answer({ type: 5, data: 'other.example' })],
    [answer({ type: 5, data: 'target.example' }), answer()]
  ]) await assert.rejects(resolve({ Status: 0, Answer: answers }));
});
