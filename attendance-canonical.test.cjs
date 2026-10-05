'use strict';
// Same checked-in corpus as APP; expected bytes/hashes are not computed by this serializer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const corpus = require('./fixtures/attendance-canonical-json-v1.json');
const canonical = require('./nexi-canonical-json.cjs');
test('canonical_json_v1 exactly matches the shared fixed UTF-8 byte/SHA-256 corpus', () => {
  assert.equal(corpus.canonical_version, canonical.VERSION);
  for (const fixture of corpus.fixtures.filter(row => row.result === 'accept')) {
    const input = JSON.parse(fixture.input_json);
    assert.equal(canonical.bytes(input), fixture.canonical_utf8, fixture.name);
    assert.equal(canonical.digest(input), fixture.sha256, fixture.name);
  }
});
test('invalid cross-language values, duplicate keys and noncanonical signed numeric lexemes are rejected', () => {
  const factories = { undefined: () => undefined, symbol: () => Symbol('x'), bigint: () => 9007199254740992n,
    nan: () => NaN, infinity: () => Infinity, binary: () => Buffer.from('x'), date: () => new Date(0),
    custom_prototype: () => Object.create({ hidden: true }), lone_surrogate: () => '\ud800',
    cycle: () => { const value = []; value.push(value); return value; }, sparse_array: () => new Array(1),
    accessor: () => Object.defineProperty({}, 'value', { enumerable: true, get() { assert.fail('getter must not execute'); } }) };
  for (const fixture of corpus.fixtures.filter(row => row.result === 'reject')) {
    assert.throws(() => fixture.input_kind === 'canonical_parse' ? canonical.parse(fixture.input_json) :
      canonical.bytes(fixture.input_json ? JSON.parse(fixture.input_json) : factories[fixture.input_kind]()), /noncanonical/, fixture.name);
  }
  assert.throws(() => canonical.bytes({}, 'canonical_json_v2'), /canonical_version_unsupported/);
});
