# Canonical JSON and input validation

Stitch uses [RFC8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html) as its JSON commitment encoding. `src/layer1-uor/custody.js` implements the application codec; it does not implement the browser's floating-point engine or claim a Lean proof of ECMAScript serialization.

## Encoding contract

- All finite IEEE754 binary64 numbers use the ECMAScript JSON serialization required by section3.2.2.3, including fractional/exponent/subnormal/large finite values and negative zero as `0`. NaN and infinities fail.
- Strings retain their exact Unicode scalar sequence. No normalization is applied. Lone surrogates and Unicode noncharacters fail, as required by the RFC7493 I-JSON input domain. JSON escaping is ECMAScript's prescribed spelling.
- Object keys are sorted by unsigned UTF16 code units at every depth, including objects nested in arrays. Array order is unchanged. Output is compact UTF8.
- `parseCanonicalJson` validates raw JSON before consumers can lose duplicate object keys. Decoded equivalent names such as `"a"` and `"\u0061"` conflict. UTF8 decoding is fatal, malformed JSON fails, and `__proto__` remains an ordinary data property in a null-prototype record.
- Programmatic values must be JSON data. Getters, custom prototypes, hidden or symbolic properties, cycles, sparse/extended arrays, BigInt and implicit coercions are not accepted. Callers must not pass a value previously parsed with a duplicate-erasing parser and then claim the original input was validated.

Byte, string, depth and entry limits are explicit deployment resource policies. They do not redefine the number domain of JCS. Wire parsing accepts explicit limits for the actual caller's operation; custody metadata retains its bounded-record defaults. Independent domain schema checks still require safe integer lengths, revisions and timestamps. Supporting JCS decimals does not permit fractional object lengths.

## Compatibility

Every valid I-JSON value accepted by the previous safe-integer codec has the same JCS bytes. The previous codec erroneously accepted Unicode noncharacters, which now fail rather than being assigned new bytes. Existing manifest and pointer fields, protocol version1, domain-separated hash framing and signature domains are unchanged. No new wire version is introduced merely to expand the codec's numeric domain. The checked-in independent custody vectors are unchanged.

The pure-execution identity currently includes exact transitive adapter source bytes, including this codec. A source change therefore produces a new execution identity even when a specific old program uses byte-compatible inputs. Existing checkpoints are not silently accepted under that new identity. To continue an old pure computation, retain its original evidence, replay its complete original program/input under the current implementation, and create a new current-identity job/checkpoint. This is re-execution, not a claim that an old checkpoint was certified by new code; host-effect VM jobs are never automatically replayed by this procedure. An automated migration/export journey is separate work until implemented.

## Evidence

`tests/canonical-json.test.js` covers every finite AppendixB number bit-pattern, nonfinite rejection, the section3.2.3 Unicode sorting vector, recursive arrays/objects, control escaping, normalization distinction, raw duplicate keys, malformed JSON/UTF8, explicit limits and1000 generated legacy-compatible records. `tests/custody.test.js` and `scripts/verify-custody.py` retain existing cryptographic and recovery vectors. The Python verifier's JSON rendering is intentionally scoped to the existing ASCII-key/integer custody schema; it is not an independent full-JCS number serializer.

Runtime parsing/canonicalization is a concrete host implementation. The Prism Identity model binds typed observations to exact canonical bytes, algorithm/domain and digest equality; it does not turn those observations into proof of browser correctness or collision resistance. Source, test and toolchain evidence must retain that distinction.
