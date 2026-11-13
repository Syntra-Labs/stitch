import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBytes, parseCanonicalJson, CUSTODY_LIMITS } from '../src/layer1-uor/custody.js';
const encoded = value => new TextDecoder().decode(canonicalBytes(value));
const invalid = action => assert.throws(action, error => error.code === 'InvalidCanonicalValue');

// Numerical facts from RFC8785 AppendixB, not a reimplementation of the ECMAScript
// serialization algorithm. Every finite bit pattern listed by the RFC is covered.
const numbers = [
 ['0000000000000000','0'], ['8000000000000000','0'],
 ['0000000000000001','5e-324'], ['8000000000000001','-5e-324'],
 ['7fefffffffffffff','1.7976931348623157e+308'], ['ffefffffffffffff','-1.7976931348623157e+308'],
 ['4340000000000000','9007199254740992'], ['c340000000000000','-9007199254740992'],
 ['4430000000000000','295147905179352830000'],
 ['44b52d02c7e14af5','9.999999999999997e+22'], ['44b52d02c7e14af6','1e+23'],
 ['44b52d02c7e14af7','1.0000000000000001e+23'],
 ['444b1ae4d6e2ef4e','999999999999999700000'], ['444b1ae4d6e2ef4f','999999999999999900000'],
 ['444b1ae4d6e2ef50','1e+21'], ['3eb0c6f7a0b5ed8c','9.999999999999997e-7'],
 ['3eb0c6f7a0b5ed8d','0.000001'], ['41b3de4355555553','333333333.3333332'],
 ['41b3de4355555554','333333333.33333325'], ['41b3de4355555555','333333333.3333333'],
 ['41b3de4355555556','333333333.3333334'], ['41b3de4355555557','333333333.33333343'],
 ['becbf647612f3696','-0.0000033333333333333333'], ['43143ff3c1cb0959','1424953923781206.2'],
];
test('RFC8785 Appendix B finite IEEE754 bit patterns and nonfinite rejection', () => {
 for (const [hex, expected] of numbers) {
  const value = Buffer.from(hex, 'hex').readDoubleBE();
  assert.equal(encoded(value), expected, hex);
  assert.equal(encoded(parseCanonicalJson(expected)), expected, hex);
 }
 for (const hex of ['7fffffffffffffff', '7ff0000000000000', 'fff0000000000000'])
  invalid(() => canonicalBytes(Buffer.from(hex, 'hex').readDoubleBE()));
});
test('RFC8785 string escaping, UTF16 property ordering, recursive objects and arrays', () => {
 const object = { '\u20ac':'Euro Sign', '\r':'Carriage Return', '\ufb33':'Hebrew Letter Dalet With Dagesh',
  '1':'One', '\ud83d\ude00':'Emoji: Grinning Face', '\u0080':'Control', '\u00f6':'Latin Small Letter O With Diaeresis' };
 const ordered = ['\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33'];
 assert.equal(encoded(object), '{' + ordered.map(k => JSON.stringify(k) + ':' + JSON.stringify(object[k])).join(',') + '}');
 assert.equal(encoded({ z:[{ b:1, a:2 },false], a:null }), '{"a":null,"z":[{"a":2,"b":1},false]}');
 assert.equal(encoded('\u0000\b\t\n\f\r\u001f"\\/€'), '"\\u0000\\b\\t\\n\\f\\r\\u001f\\"\\\\/€"');
 assert.notEqual(encoded('\u00e9'), encoded('e\u0301'), 'Unicode must not be normalized');
 assert.equal(encoded(-0), '0');
});
test('wire parser detects duplicate and escape-equivalent names before signature admission', () => {
 for (const value of ['{"a":1,"a":2}', '{"a":1,"\\u0061":1}', '{"x":[{"nested":1,"nested":2}]}',
  '{"__proto__":1,"__proto__":2}']) invalid(() => parseCanonicalJson(value));
 const parsed = parseCanonicalJson('{"__proto__":{"polluted":true},"constructor":3}');
 assert.equal(Object.getPrototypeOf(parsed), null);
 assert.equal({}.polluted, undefined);
 assert.equal(parsed.__proto__.polluted, true);
 assert.equal(encoded(parsed), '{"__proto__":{"polluted":true},"constructor":3}');
});
test('wire parser refuses malformed JSON, Unicode and UTF8 without value coercion', () => {
 for (const value of ['', 'undefined', 'NaN', 'Infinity', '1e999', '-1e999', '01', '+1', '1.', '1e', '[1,]',
  '{"a":1,}', '{a:1}', 'null true', '/*x*/1', '\ufeff{}', '"\\ud800"', '"\\udfff"', '"\ud800"',
  '"\\v"', '"\\uXX00"', '"unfinished', '"line\nfeed"', '{"a" 1}', '[,1]']) invalid(() => parseCanonicalJson(value));
 for (const bytes of [[0xc0,0xaf], [34,0xed,0xa0,0x80,34], [0xef,0xbb,0xbf,123,125]])
  invalid(() => parseCanonicalJson(Uint8Array.from(bytes)));
 for (const value of [null, {}, 1]) invalid(() => parseCanonicalJson(value));
 assert.equal(encoded(parseCanonicalJson(' \n {"n":4.50,"s":"\\u0065\\u0301"}\t ')), '{"n":4.5,"s":"é"}');
});
test('parser bounds are explicit resource policies and run before uncontrolled allocation', () => {
 const limit = action => assert.throws(action, e => e.code === 'SizeLimit');
 limit(() => parseCanonicalJson('"€"', {maxBytes:4}));
 limit(() => parseCanonicalJson('[[null]]', {maxDepth:1}));
 limit(() => parseCanonicalJson('[1,2,3]', {maxEntries:3}));
 limit(() => parseCanonicalJson('"four"', {maxStringLength:3}));
 limit(() => parseCanonicalJson('null', {maxBytes:Infinity}));
 assert.equal(parseCanonicalJson('"longer"', {maxStringLength:10}), 'longer');
 assert.equal(parseCanonicalJson(' '.repeat(100) + 'null', {maxBytes:104}), null);
 limit(() => canonicalBytes('a'.repeat(CUSTODY_LIMITS.maxStringLength + 1)));
});
test('legacy safe-integer canonical values retain exact bytes; schema validation remains separate', () => {
 const old = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v)
  ? '[' + v.map(old).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+old(v[k])).join(',') + '}';
 for (let i=0; i<1000; i++) {
  const v={z:[i, -i || 0, Number.MAX_SAFE_INTEGER-i, true, null], a:{'😀':`row${i}`, 'é':'é', one:1}};
  assert.equal(encoded(v), old(v));
 }
});

test('RFC7493 I-JSON noncharacters are rejected in values and keys, raw and escaped', () => {
 const points = [...Array.from({length:32}, (_,i)=>0xfdd0+i), ...Array.from({length:17},(_,i)=>[i*65536+65534,i*65536+65535]).flat()];
 for (const point of points) {
  const s = String.fromCodePoint(point);
  invalid(() => canonicalBytes(s)); invalid(() => canonicalBytes({[s]:1}));
  invalid(() => parseCanonicalJson(JSON.stringify(s)));
  invalid(() => parseCanonicalJson(JSON.stringify({[s]:1})));
  const escaped = s.split('').map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
  invalid(() => parseCanonicalJson('"'+escaped+'"'));
  invalid(() => parseCanonicalJson('{"'+escaped+'":1}'));
 }
 for (const point of [0xfdd0-1, 0xfdef+1, 0xfffd, 0x1fffd, 0x10fffd])
  assert.equal(parseCanonicalJson(JSON.stringify(String.fromCodePoint(point))),String.fromCodePoint(point));
});
