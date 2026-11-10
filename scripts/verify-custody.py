#!/usr/bin/env python3
"""Independent stdlib implementation of Stitch's raw custody commitments.

No JavaScript/Prism runtime or network is used. --write-fixtures is for deliberate
fixture regeneration; the default only verifies the checked-in vectors and all
three recovery pairs, then tests malformed encodings. This establishes agreement
on this bounded corpus, not whole-browser formal correspondence or durability.
"""
import argparse
import copy
import hashlib
import json
import pathlib
import struct

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'tests/fixtures/custody-vectors.json'
MAX_BYTES = 16 * 1024 * 1024


def digest(payload, domain):
    frame = ('stitch/' + domain + '/v1\0').encode('ascii') + struct.pack('>Q', len(payload)) + payload
    return 'sha256:' + hashlib.sha256(frame).hexdigest()


def canonical(value):
    # Fixture/model record keys are ASCII. ensure_ascii=False matches compact
    # JSON UTF-8, not an escaped representation of non-ASCII content.
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def fragment_digest(encoding, index, data):
    return digest(bytes.fromhex(encoding[7:]) + struct.pack('>I', index) + data, 'fragment')


def split(data):
    n = (len(data) + 1) // 2
    left = data[:n]
    right = data[n:] + bytes(n - len(data[n:]))
    return [left, right, bytes(a ^ b for a, b in zip(left, right))]


def create(data):
    assert len(data) <= MAX_BYTES
    shards = split(data)
    encoding = digest(data, 'encoding')
    body = {
        'version': 1,
        'object': {'digestAlgorithm': 'sha256', 'contentDigest': digest(data, 'object'), 'byteLength': len(data)},
        'encoding': {'format': 'raw', 'encodingDigest': encoding, 'byteLength': len(data), 'dependencies': []},
        'fragments': {'scheme': 'xor-2-of-3', 'threshold': 2, 'count': 3, 'byteLength': len(shards[0]),
                      'digests': [fragment_digest(encoding, i, b) for i, b in enumerate(shards)]},
    }
    return dict(body, manifestDigest=digest(canonical(body), 'manifest')), shards


def keys(value, expected):
    assert type(value) is dict and set(value) == set(expected)


def is_digest(value):
    assert type(value) is str and len(value) == 71 and value.startswith('sha256:')
    assert all(c in '0123456789abcdef' for c in value[7:])


def verify_manifest(m):
    keys(m, ['version', 'object', 'encoding', 'fragments', 'manifestDigest'])
    keys(m['object'], ['digestAlgorithm', 'contentDigest', 'byteLength'])
    keys(m['encoding'], ['format', 'encodingDigest', 'byteLength', 'dependencies'])
    keys(m['fragments'], ['scheme', 'threshold', 'count', 'byteLength', 'digests'])
    assert type(m['version']) is int and m['version'] == 1
    assert m['object']['digestAlgorithm'] == 'sha256' and m['encoding']['format'] == 'raw'
    n = m['object']['byteLength']
    assert type(n) is int and 0 <= n <= MAX_BYTES
    assert type(m['encoding']['byteLength']) is int and m['encoding']['byteLength'] == n
    assert m['encoding']['dependencies'] == [] and type(m['encoding']['dependencies']) is list
    f = m['fragments']
    assert f['scheme'] == 'xor-2-of-3' and type(f['threshold']) is int and f['threshold'] == 2
    assert type(f['count']) is int and f['count'] == 3
    assert type(f['byteLength']) is int and f['byteLength'] == (n + 1) // 2
    assert type(f['digests']) is list and len(f['digests']) == 3
    for d in [m['manifestDigest'], m['object']['contentDigest'], m['encoding']['encodingDigest'], *f['digests']]:
        is_digest(d)
    body = {k: v for k, v in m.items() if k != 'manifestDigest'}
    assert digest(canonical(body), 'manifest') == m['manifestDigest']


def recover(m, supplied):
    verify_manifest(m)
    assert 2 <= len(supplied) <= 3
    assert len({i for i, _ in supplied}) == len(supplied)
    shards = [None] * 3
    for index, data in supplied:
        assert type(index) is int and 0 <= index < 3 and type(data) is bytes
        assert len(data) == m['fragments']['byteLength']
        assert fragment_digest(m['encoding']['encodingDigest'], index, data) == m['fragments']['digests'][index]
        shards[index] = data
    if shards[0] is None:
        shards[0] = bytes(a ^ b for a, b in zip(shards[1], shards[2]))
    if shards[1] is None:
        shards[1] = bytes(a ^ b for a, b in zip(shards[0], shards[2]))
    n = m['object']['byteLength']
    if n % 2:
        assert shards[1][-1] == 0
    data = (shards[0] + shards[1])[:n]
    recreated, _ = create(data)
    assert recreated == m
    return data


def fixture_data():
    corpus = [('empty', b''), ('one-zero', b'\0'), ('odd', bytes([0, 1, 2, 254, 255])),
              ('even', bytes([0, 1, 2, 3, 254, 255])), ('utf8', 'Stitch \u2603 \U0001f9f5'.encode()),
              ('all-bytes', bytes(range(256)))]
    vectors = []
    for name, data in corpus:
        manifest, shards = create(data)
        vectors.append({'name': name, 'objectHex': data.hex(), 'manifest': manifest,
                        'fragments': [{'index': i, 'hex': b.hex()} for i, b in enumerate(shards)]})
    manifest, shards = create(bytes([1, 2, 3]))
    invalid = []

    def add(name, expected, m=None, supplied=None):
        m = copy.deepcopy(manifest) if m is None else m
        supplied = [(0, shards[0]), (1, shards[1])] if supplied is None else supplied
        invalid.append({'name': name, 'expectedError': expected, 'manifest': m,
                        'fragments': [{'index': i, 'hex': b.hex()} for i, b in supplied]})

    add('duplicate-index', 'DuplicateFragment', supplied=[(0, shards[0]), (0, shards[0])])
    add('missing-fragment', 'InsufficientFragments', supplied=[(0, shards[0])])
    truncated = copy.deepcopy(manifest)
    truncated['object']['contentDigest'] = truncated['object']['contentDigest'][:24]
    add('truncated-object-digest', 'InvalidDigest', truncated)
    dependencies = copy.deepcopy(manifest)
    dependencies['encoding']['dependencies'] = ['sha256:' + 'a' * 64]
    add('undeclared-external-basis', 'InvalidSchema', dependencies)
    add('forged-fragment', 'FragmentDigestMismatch', supplied=[(0, bytes([shards[0][0] ^ 1, shards[0][1]])), (1, shards[1])])
    absent = copy.deepcopy(manifest)
    absent['fragments']['digests'][2] = 'sha256:' + '0' * 64
    absent['manifestDigest'] = digest(canonical({k: v for k, v in absent.items() if k != 'manifestDigest'}), 'manifest')
    add('inconsistent-absent-fragment', 'InvalidParity', absent)
    padding = copy.deepcopy(manifest)
    bad_shards = [shards[0], bytes([shards[1][0], 7]), bytes([shards[2][0], shards[2][1] ^ 7])]
    padding['fragments']['digests'] = [fragment_digest(padding['encoding']['encodingDigest'], i, b) for i, b in enumerate(bad_shards)]
    padding['manifestDigest'] = digest(canonical({k: v for k, v in padding.items() if k != 'manifestDigest'}), 'manifest')
    add('nonzero-padding', 'InvalidPadding', padding, [(0, bad_shards[0]), (1, bad_shards[1])])
    wrong_object = copy.deepcopy(manifest)
    wrong_object['object']['contentDigest'] = 'sha256:' + '0' * 64
    wrong_object['manifestDigest'] = digest(canonical({k: v for k, v in wrong_object.items() if k != 'manifestDigest'}), 'manifest')
    add('object-does-not-match', 'ObjectDigestMismatch', wrong_object)
    wrong_encoding = copy.deepcopy(manifest)
    wrong_encoding['encoding']['encodingDigest'] = 'sha256:' + '0' * 64
    wrong_encoding['fragments']['digests'] = [fragment_digest(wrong_encoding['encoding']['encodingDigest'], i, b) for i, b in enumerate(shards)]
    wrong_encoding['manifestDigest'] = digest(canonical({k: v for k, v in wrong_encoding.items() if k != 'manifestDigest'}), 'manifest')
    add('encoding-does-not-match', 'EncodingDigestMismatch', wrong_encoding)
    return {'version': 1, 'hashFrame': 'UTF8(stitch/<domain>/v1\\0)||uint64be(length)||payload',
            'vectors': vectors, 'invalidVectors': invalid}


def must_reject(action):
    try:
        action()
    except (AssertionError, KeyError, ValueError, TypeError, IndexError):
        return
    raise AssertionError('Malformed input was accepted')


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--write-fixtures', action='store_true')
    options = args.parse_args()
    generated = fixture_data()
    if options.write_fixtures:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(generated, ensure_ascii=False, indent=2) + '\n')
    fixture = json.loads(FIXTURE.read_text())
    assert fixture == generated, 'Checked-in commitments differ from independent Python implementation'
    pairs = [(0, 1), (0, 2), (1, 2)]
    for v in fixture['vectors']:
        data = bytes.fromhex(v['objectHex'])
        shards = [bytes.fromhex(f['hex']) for f in v['fragments']]
        for a, b in pairs:
            assert recover(v['manifest'], [(a, shards[a]), (b, shards[b])]) == data
        must_reject(lambda: recover(v['manifest'], [(0, shards[0]), (0, shards[0])]))
        bad = copy.deepcopy(v['manifest'])
        bad['object']['contentDigest'] = bad['object']['contentDigest'][:-1]
        must_reject(lambda: verify_manifest(bad))
    for v in fixture['invalidVectors']:
        supplied = [(f['index'], bytes.fromhex(f['hex'])) for f in v['fragments']]
        must_reject(lambda: recover(v['manifest'], supplied))
    m, shards = create(bytes([1, 2, 3]))
    bad = copy.deepcopy(m)
    bad['fragments']['digests'][2] = digest(b'incorrect', 'fragment')
    body = {k: v for k, v in bad.items() if k != 'manifestDigest'}
    bad['manifestDigest'] = digest(canonical(body), 'manifest')
    must_reject(lambda: recover(bad, [(0, shards[0]), (1, shards[1])]))
    print(f"Independent Python custody verification: {len(fixture['vectors'])} valid vectors, {len(pairs) * len(fixture['vectors'])} recovery pairs, {len(fixture['invalidVectors'])} shared invalid vectors rejected")


if __name__ == '__main__':
    main()
